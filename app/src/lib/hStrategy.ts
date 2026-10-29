import { trendChannel } from './indicators.ts'
import { BTC_SPEC, applyFlip, rebalance, valuation, type Ledger, type Spec } from './hPlan.ts'
import type { Candle, TrendState } from './types.ts'

/**
 * BTC H 方案：信号检测与「实际持仓 → 目标持仓」对账。
 *
 * 只读日线已收盘 K 线；数量按币安实际持仓计算，和企业微信推送用同一套 hPlan 规则。
 * 类型只依赖结构（不 import mygo.ts），方便在 node 下单测。
 */

export const DAY_MS = 86_400_000

export type Account = '现货' | '币本位' | 'U本位' | '划转'

export interface PlanStep {
  account: Account
  text: string
  /** 数量的算法，便于核对 */
  detail: string
}

/** 与 Go 侧 Snapshot 结构一致 */
export interface Holdings {
  spot: { usdt: number; btc: number }
  coinM: { walletBtc: number; unrealizedBtc: number; contracts: number; entry: number }
  usdM: { walletUsdt: number; unrealizedUsdt: number; shortQty: number; entry: number }
}

export interface StrategyState {
  state: number
  lastCandleTime: number
  lastRebalanceYear: number
}

export interface DailySignal {
  state: TrendState
  /** 最后一根已收盘日线 */
  candleTime: number
  close: number
  upper: number
  lower: number
  /** 当前状态开始的那根日线（翻转日），以及它的收盘价 */
  flipTime: number | null
  flipClose: number | null
  /** 当前状态已持续的日线根数 */
  barsSinceFlip: number
}

/** 从日线算出最新已收盘的信号。未收盘的那根不参与，避免盘中假信号 */
export function dailySignal(candles: readonly Candle[]): DailySignal | null {
  const closed = candles.filter((c) => c.closed)
  if (closed.length < 100) return null
  const ch = trendChannel(closed)
  const last = ch.points[ch.points.length - 1]
  const lastCandle = closed[closed.length - 1]
  let flipIdx = -1
  for (let i = ch.points.length - 1; i >= 0; i--) {
    if (ch.points[i].flipped) {
      flipIdx = i
      break
    }
  }
  return {
    state: last.state,
    candleTime: lastCandle.time,
    close: lastCandle.close,
    upper: last.upper,
    lower: last.lower,
    flipTime: flipIdx >= 0 ? closed[flipIdx].time : null,
    flipClose: flipIdx >= 0 ? closed[flipIdx].close : null,
    barsSinceFlip: flipIdx >= 0 ? ch.points.length - 1 - flipIdx : ch.points.length,
  }
}

/** 日线收盘时刻所在的年份（UTC，即北京时间 08:00 收盘那天） */
export function closeYear(candleTime: number): number {
  return new Date(candleTime + DAY_MS).getUTCFullYear()
}

/** 北京时间 MM-DD，按收盘时刻（开盘 + 1 天）计 */
export function closeDate(candleTime: number, withYear = false): string {
  const d = new Date(candleTime + DAY_MS + 8 * 3_600_000).toISOString()
  return withYear ? d.slice(0, 10) : d.slice(5, 10)
}

export function ledgerFromHoldings(h: Holdings, state: TrendState): Ledger {
  return {
    state,
    main: {
      usdt: h.spot.usdt,
      btc: h.spot.btc + h.coinM.walletBtc,
      hedgeContracts: Math.max(0, h.coinM.contracts),
      hedgeEntry: h.coinM.entry,
    },
    sleeve: {
      usdt: h.usdM.walletUsdt,
      shortQty: Math.max(0, h.usdM.shortQty),
      shortEntry: h.usdM.entry,
    },
    lastCandleTime: 0,
    lastRebalanceYear: 0,
  }
}

export function floorTo(x: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return Number((Math.floor(x / step + 1e-9) * step).toFixed(decimals))
}

export const fmtBtc = (x: number): string => x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
export const fmtUsd = (x: number, d = 2): string =>
  x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/** 币本位空单张数允许的偏差：资金费、手续费会让目标张数在 ±1 之间跳动 */
const CONTRACT_TOLERANCE = 1

/**
 * 对账：给定趋势状态与实际持仓，列出要做的操作。返回空数组表示持仓已符合目标。
 * holdings 为 null（未设置 Key）时给出不带具体数量的通用步骤。
 */
export function reconcile(
  state: TrendState,
  h: Holdings | null,
  price: number,
  spec: Spec = BTC_SPEC,
): PlanStep[] {
  if (!h) return genericSteps(state)
  const steps: PlanStep[] = []
  const minSpot = spec.spotMinNotional

  // 策略只开空单，出现多单先平掉，再按规则处理
  if (h.coinM.contracts < 0) {
    steps.push({ account: '币本位', text: `BTCUSD 永续平多 ${-h.coinM.contracts} 张`, detail: '策略只开空单' })
  }
  if (h.usdM.shortQty < 0) {
    steps.push({ account: 'U本位', text: `BTCUSDT 永续平多 ${fmtBtc(-h.usdM.shortQty)} BTC`, detail: '策略只开空单' })
  }

  if (state === 1) {
    if (h.coinM.contracts > 0) {
      steps.push({ account: '币本位', text: `BTCUSD 永续平空 ${h.coinM.contracts} 张`, detail: '买入平空，盈亏以 BTC 结算，留在币本位账户' })
    }
    if (h.spot.usdt >= minSpot) {
      const q = (h.spot.usdt * (1 - spec.spotFee)) / price
      steps.push({
        account: '现货',
        text: `用 ${fmtUsd(h.spot.usdt)} USDT 买入 BTC`,
        detail: `约 ${fmtBtc(q)} BTC，买入后划转到币本位账户`,
      })
    } else if (h.spot.btc * price >= minSpot) {
      steps.push({ account: '划转', text: `现货 ${fmtBtc(h.spot.btc)} BTC 划转到币本位`, detail: '主仓 BTC 统一放在币本位账户' })
    }
    if (h.usdM.shortQty > 0) {
      steps.push({ account: 'U本位', text: `BTCUSDT 永续平空 ${fmtBtc(h.usdM.shortQty)} BTC`, detail: '平仓后空单仓持有 USDT' })
    }
    return steps
  }

  // 空头
  if (h.spot.btc * price >= minSpot) {
    steps.push({ account: '划转', text: `现货 ${fmtBtc(h.spot.btc)} BTC 划转到币本位`, detail: '现货 BTC 不卖，转到币本位后用空单锁定价值' })
  }
  const btc = h.coinM.walletBtc + h.coinM.unrealizedBtc + h.spot.btc
  const target = Math.floor((btc * price) / spec.coinContractUsd + 1e-9)
  const formula = `${fmtBtc(btc)} BTC × ${fmtUsd(price, 0)} ÷ ${spec.coinContractUsd} → ${target}`
  if (h.coinM.contracts <= 0) {
    if (target >= 1) {
      steps.push({ account: '币本位', text: `BTCUSD 永续开空 ${target} 张`, detail: `${formula} · 逐仓 1×` })
    } else if (btc * price >= minSpot) {
      steps.push({ account: '现货', text: `卖出 ${fmtBtc(btc)} BTC`, detail: '持币不足 1 张合约，直接卖成 USDT' })
    }
  } else if (Math.abs(h.coinM.contracts - target) > CONTRACT_TOLERANCE) {
    const d = target - h.coinM.contracts
    steps.push({
      account: '币本位',
      text: d > 0 ? `BTCUSD 永续加空 ${d} 张` : `BTCUSD 永续平空 ${-d} 张`,
      detail: `目标 ${formula}，当前 ${h.coinM.contracts} 张`,
    })
  }
  if (h.usdM.shortQty <= 0) {
    const q = floorTo(h.usdM.walletUsdt / (price * (1 + spec.futFee)), spec.usdtStep)
    if (q * price >= spec.usdtMinNotional) {
      steps.push({
        account: 'U本位',
        text: `BTCUSDT 永续开空 ${fmtBtc(q)} BTC`,
        detail: `${fmtUsd(h.usdM.walletUsdt, 0)} ÷ ${fmtUsd(price, 0)} → ${fmtBtc(q)} · 逐仓 1×`,
      })
    }
  } else {
    // 已有空单：按开仓价核对数量。开仓时向下取整，之后资金费只让余额小幅变化，
    // 所以差出一整步（0.001 BTC）才提示
    const entry = h.usdM.entry > 0 ? h.usdM.entry : price
    const target = floorTo(h.usdM.walletUsdt / (entry * (1 + spec.futFee)), spec.usdtStep)
    const diff = Number((target - h.usdM.shortQty).toFixed(6))
    const formula = `目标 ${fmtUsd(h.usdM.walletUsdt, 0)} ÷ ${fmtUsd(entry, 0)} → ${fmtBtc(target)}，当前 ${fmtBtc(h.usdM.shortQty)}`
    if (diff >= spec.usdtStep - 1e-9) {
      steps.push({ account: 'U本位', text: `BTCUSDT 永续加空 ${fmtBtc(diff)} BTC`, detail: formula })
    } else if (-diff >= spec.usdtStep - 1e-9 && h.usdM.shortQty * entry > h.usdM.walletUsdt) {
      steps.push({ account: 'U本位', text: `BTCUSDT 永续平空 ${fmtBtc(-diff)} BTC`, detail: `${formula}，名义价值超过保证金（超过 1 倍）` })
    }
  }
  return steps
}

function genericSteps(state: TrendState): PlanStep[] {
  if (state === 1) {
    return [
      { account: '币本位', text: 'BTCUSD 永续平掉全部空单', detail: '未设置 API Key，数量请按实际持仓' },
      { account: '现货', text: '主仓 USDT 全部买入 BTC', detail: '买入后划转到币本位账户' },
      { account: 'U本位', text: 'BTCUSDT 永续平掉全部空单', detail: '平仓后空单仓持有 USDT' },
    ]
  }
  return [
    { account: '币本位', text: 'BTCUSD 永续开空', detail: '张数 = BTC × 价格 ÷ 100，向下取整 · 逐仓 1×' },
    { account: 'U本位', text: 'BTCUSDT 永续开空', detail: '数量 = USDT ÷ 价格，向下取整到 0.001 · 逐仓 1×' },
  ]
}

/** 年度再平衡步骤。flipTo 不为空时先模拟当天的翻转，再按翻转后的持仓再平衡 */
export function rebalanceSteps(
  h: Holdings | null,
  state: TrendState,
  price: number,
  year: number,
  flipFrom?: TrendState,
): PlanStep[] {
  if (!h) {
    return [{ account: '划转', text: '把主仓与空单仓拉回 70 : 30', detail: '未设置 API Key，请按指南手动计算' }]
  }
  let ledger = ledgerFromHoldings(h, flipFrom ?? state)
  if (flipFrom !== undefined && flipFrom !== state) ledger = applyFlip(ledger, state, price).ledger
  return rebalance(ledger, price, year).steps.map((s) => ({
    account: s.account,
    text: s.text.replace(/\*\*/g, ''),
    detail: '',
  }))
}

export interface NewTaskInput {
  kind: 'flip' | 'rebalance'
  title: string
  candleTime: number
  close: number
  note: string
  steps: PlanStep[]
  supersede: boolean
}

export interface Detection {
  tasks: NewTaskInput[]
  state: StrategyState
  /** 没有新信号但已处理的日线前进了，只需保存进度 */
  advanced: boolean
}

/**
 * 比较最新信号与已处理的进度，决定要生成哪些操作记录。
 * 返回 null 表示没有任何变化。
 */
export function detect(sig: DailySignal, stored: StrategyState | null, h: Holdings | null): Detection | null {
  const year = closeYear(sig.candleTime)
  const next: StrategyState = { state: sig.state, lastCandleTime: sig.candleTime, lastRebalanceYear: year }

  // 首次运行只记下当前状态，不生成记录：程序不知道你是否已经建好仓，
  // 实际持仓与目标的差异由持仓卡片逐项提示
  if (!stored) return { tasks: [], state: next, advanced: true }
  if (sig.candleTime <= stored.lastCandleTime) return null

  const tasks: NewTaskInput[] = []
  const flipped = sig.state !== stored.state
  if (flipped) {
    tasks.push({
      kind: 'flip',
      title: sig.state === 1 ? '转多' : '转空',
      candleTime: sig.flipTime ?? sig.candleTime,
      close: sig.flipClose ?? sig.close,
      note: sig.state === 1 ? `收盘 > 上轨 ${fmtUsd(sig.upper, 0)}` : `收盘 < 下轨 ${fmtUsd(sig.lower, 0)}`,
      steps: reconcile(sig.state, h, sig.close),
      supersede: true,
    })
  }
  if (year > stored.lastRebalanceYear) {
    tasks.push({
      kind: 'rebalance',
      title: `${year} 年度再平衡`,
      candleTime: sig.candleTime,
      close: sig.close,
      note: '主仓 : 空单仓 = 70 : 30',
      steps: rebalanceSteps(h, sig.state, sig.close, year, flipped ? (stored.state as TrendState) : undefined),
      supersede: !flipped,
    })
  } else {
    next.lastRebalanceYear = stored.lastRebalanceYear
  }
  return { tasks, state: next, advanced: true }
}

/** 持仓估值：主仓、空单仓、合计与主仓占比 */
export function holdingsValue(h: Holdings, price: number, state: TrendState) {
  const v = valuation(ledgerFromHoldings(h, state), price)
  return { ...v, mainRatio: v.total > 0 ? v.main / v.total : 0 }
}
