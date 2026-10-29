import type { TrendState } from '../lib/types.ts'

/**
 * BTC 对冲版（H 方案）的建议账本与操作生成。规则见 docs/趋势通道对冲版策略.md。
 *
 * - 主仓（70%）：多头持现货；空头期现货不动，在币本位 BTCUSD 永续开等量 1x 空单锁定价值。
 *   币本位合约以 BTC 结算，盈亏直接体现为 BTC 数量变化，不需要买卖现货补差。
 * - 空单仓（30%）：空头期在 U 本位 BTCUSDT 永续 1x 逐仓做空，多头期持有 USDT。
 * - 每年 1 月 1 日把两部分拉回 70:30。
 *
 * 账本假设用户按提醒成交，价格用最新收盘价估算（回测按次日开盘成交，两者几乎相同）。
 * 资金费未计入；实际持仓与账本有出入时，通过 /ledger 接口同步。
 */

export interface Spec {
  /** 主仓占比 */
  mainRatio: number
  /** 币本位 BTCUSD 永续每张面值（美元） */
  coinContractUsd: number
  /** U 本位 BTCUSDT 数量步长 */
  usdtStep: number
  /** U 本位 BTCUSDT 最小名义价值 */
  usdtMinNotional: number
  /** 现货最小下单金额 */
  spotMinNotional: number
  spotFee: number
  futFee: number
}

export const BTC_SPEC: Spec = {
  mainRatio: 0.7,
  coinContractUsd: 100,
  usdtStep: 0.001,
  usdtMinNotional: 50,
  spotMinNotional: 5,
  spotFee: 0.001,
  futFee: 0.0005,
}

export interface Ledger {
  /** 账本所处的趋势状态 */
  state: TrendState
  main: {
    usdt: number
    btc: number
    /** 币本位空单张数 */
    hedgeContracts: number
    hedgeEntry: number
  }
  sleeve: {
    usdt: number
    /** U 本位空单数量（BTC） */
    shortQty: number
    shortEntry: number
  }
  /** 已处理到的最后一根已收盘日线的开盘时间（毫秒） */
  lastCandleTime: number
  /** 最近一次完成再平衡的年份 */
  lastRebalanceYear: number
}

export interface Step {
  /** 涉及的账户 */
  account: '现货' | '币本位' | 'U本位' | '划转'
  text: string
}

export interface PlanResult {
  ledger: Ledger
  steps: Step[]
}

/** 向下取整到步长，并按步长的小数位规整，避免 0.013000000000000001 这类下单数量被交易所拒绝 */
function floorTo(x: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return Number((Math.floor(x / step + 1e-9) * step).toFixed(decimals))
}

function fmtBtc(x: number): string {
  return x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtUsd(x: number): string {
  return x.toFixed(2)
}

function clone(l: Ledger): Ledger {
  return structuredClone(l)
}

/** 币本位空单的浮动盈亏（BTC）：反向合约，空单盈亏 = 张数 × 面值 × (1/现价 − 1/开仓价) */
function hedgePnlBtc(l: Ledger, price: number, spec: Spec): number {
  const { hedgeContracts: n, hedgeEntry: e } = l.main
  return n === 0 ? 0 : n * spec.coinContractUsd * (1 / price - 1 / e)
}

/** 按价格估算两部分的美元价值 */
export function valuation(l: Ledger, price: number, spec: Spec = BTC_SPEC) {
  const main = l.main.usdt + (l.main.btc + hedgePnlBtc(l, price, spec)) * price
  const sleeve = l.sleeve.usdt + l.sleeve.shortQty * (l.sleeve.shortEntry - price)
  return { main, sleeve, total: main + sleeve }
}

function enterLong(l: Ledger, price: number, spec: Spec, steps: Step[]): void {
  const m = l.main
  if (m.hedgeContracts > 0) {
    const pnl = hedgePnlBtc(l, price, spec)
    const fee = (m.hedgeContracts * spec.coinContractUsd / price) * spec.futFee
    m.btc += pnl - fee
    steps.push({
      account: '币本位',
      text: `BTCUSD 永续 **平空 ${m.hedgeContracts} 张**（盈亏约 ${pnl >= 0 ? '+' : ''}${fmtBtc(pnl)} BTC，BTC 留在币本位账户）`,
    })
    m.hedgeContracts = 0
    m.hedgeEntry = 0
  }
  if (m.usdt >= spec.spotMinNotional) {
    const q = (m.usdt * (1 - spec.spotFee)) / price
    steps.push({ account: '现货', text: `用 **${fmtUsd(m.usdt)} USDT 买入 BTC**（约 ${fmtBtc(q)} BTC），买入后划转到币本位合约账户` })
    m.btc += q
    m.usdt = 0
  }

  const s = l.sleeve
  if (s.shortQty > 0) {
    const pnl = s.shortQty * (s.shortEntry - price)
    s.usdt += pnl - s.shortQty * price * spec.futFee
    steps.push({ account: 'U本位', text: `BTCUSDT 永续 **平空 ${fmtBtc(s.shortQty)} BTC**（盈亏约 ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} USDT），之后持有 USDT` })
    s.shortQty = 0
    s.shortEntry = 0
  }
  l.state = 1
}

function enterShort(l: Ledger, price: number, spec: Spec, steps: Step[]): void {
  const m = l.main
  if (m.btc > 0 && m.hedgeContracts === 0) {
    const n = Math.floor((m.btc * price) / spec.coinContractUsd + 1e-9)
    if (n >= 1) {
      m.btc -= (n * spec.coinContractUsd / price) * spec.futFee
      m.hedgeContracts = n
      m.hedgeEntry = price
      const coverage = (n * spec.coinContractUsd) / (m.btc * price)
      steps.push({
        account: '币本位',
        text: `BTCUSD 永续 1 倍逐仓 **开空 ${n} 张**（对冲 ${(coverage * 100).toFixed(0)}% 的持币，现货不卖）`,
      })
    } else if (m.btc * price >= spec.spotMinNotional) {
      // 持币不足一张合约：退回基础版做法，直接卖成 USDT
      const usd = m.btc * price * (1 - spec.spotFee)
      steps.push({ account: '现货', text: `持币不足 1 张合约，直接 **卖出 ${fmtBtc(m.btc)} BTC**（约 ${fmtUsd(usd)} USDT）` })
      m.usdt += usd
      m.btc = 0
    }
  }

  const s = l.sleeve
  if (s.shortQty === 0) {
    const q = floorTo(s.usdt / (price * (1 + spec.futFee)), spec.usdtStep)
    if (q * price >= spec.usdtMinNotional) {
      s.usdt -= q * price * spec.futFee
      s.shortQty = q
      s.shortEntry = price
      steps.push({
        account: 'U本位',
        text: `BTCUSDT 永续 1 倍逐仓 **开空 ${fmtBtc(q)} BTC**（名义约 ${fmtUsd(q * price)} USDT，强平价约 ${Math.round(price * 1.98)}）`,
      })
    } else {
      steps.push({ account: 'U本位', text: `空单仓 USDT 不足最小下单量（${spec.usdtMinNotional} USDT），本次不开空` })
    }
  }
  l.state = 0
}

/** 首次运行：从全部 USDT 出发，按当前状态给出建仓操作 */
export function initLedger(capital: number, state: TrendState, price: number, candleTime: number, year: number, spec: Spec = BTC_SPEC): PlanResult {
  const ledger: Ledger = {
    state,
    main: { usdt: capital * spec.mainRatio, btc: 0, hedgeContracts: 0, hedgeEntry: 0 },
    sleeve: { usdt: capital - capital * spec.mainRatio, shortQty: 0, shortEntry: 0 },
    lastCandleTime: candleTime,
    lastRebalanceYear: year,
  }
  const steps: Step[] = [
    { account: '划转', text: `主仓 ${fmtUsd(ledger.main.usdt)} USDT 留在现货账户，空单仓 ${fmtUsd(ledger.sleeve.usdt)} USDT 划转到 U 本位合约账户` },
  ]
  if (state === 1) {
    enterLong(ledger, price, spec, steps)
  } else {
    // 空头期主仓持有 USDT 与「现货 + 等量空单」等价，建仓时不必先买再对冲
    steps.push({ account: '现货', text: '当前为空头：主仓继续持有 USDT，等转多时再买入' })
    enterShort(ledger, price, spec, steps)
  }
  return { ledger, steps }
}

/** 趋势翻转 */
export function applyFlip(prev: Ledger, to: TrendState, price: number, spec: Spec = BTC_SPEC): PlanResult {
  const ledger = clone(prev)
  const steps: Step[] = []
  if (to === ledger.state) return { ledger, steps }
  if (to === 1) enterLong(ledger, price, spec, steps)
  else enterShort(ledger, price, spec, steps)
  return { ledger, steps }
}

/**
 * 年度再平衡：把主仓与空单仓拉回 mainRatio。
 * 偏差小于总值的 1% 时不调整，避免无意义的来回划转。
 */
export function rebalance(prev: Ledger, price: number, year: number, spec: Spec = BTC_SPEC): PlanResult {
  const ledger = clone(prev)
  const steps: Step[] = []
  ledger.lastRebalanceYear = year
  const v = valuation(ledger, price, spec)
  const delta = v.total * spec.mainRatio - v.main          // 正：空单仓 → 主仓
  if (Math.abs(delta) < v.total * 0.01) {
    steps.push({ account: '划转', text: `主仓占比 ${(v.main / v.total * 100).toFixed(1)}%，偏差小于 1%，今年不调整` })
    return { ledger, steps }
  }

  const bear = ledger.state === 0
  const m = ledger.main
  const s = ledger.sleeve
  // 空单仓有持仓时先平掉，划转后按新资金重开
  if (s.shortQty > 0) {
    const pnl = s.shortQty * (s.shortEntry - price)
    s.usdt += pnl - s.shortQty * price * spec.futFee
    steps.push({ account: 'U本位', text: `BTCUSDT **平空 ${fmtBtc(s.shortQty)} BTC**（再平衡后重开）` })
    s.shortQty = 0
    s.shortEntry = 0
  }

  if (delta > 0) {
    s.usdt -= delta
    m.usdt += delta
    steps.push({ account: '划转', text: `从 U 本位账户划出 **${fmtUsd(delta)} USDT** 到现货账户（主仓）` })
    if (!bear) {
      const q = (m.usdt * (1 - spec.spotFee)) / price
      steps.push({ account: '现货', text: `用 ${fmtUsd(m.usdt)} USDT **买入 BTC**（约 ${fmtBtc(q)} BTC），划转到币本位账户` })
      m.btc += q
      m.usdt = 0
    } else {
      steps.push({ account: '现货', text: '当前为空头：这部分 USDT 留在主仓，转多时一起买入' })
    }
  } else {
    let need = -delta
    const fromUsdt = Math.min(m.usdt, need)
    m.usdt -= fromUsdt
    need -= fromUsdt
    if (need > 0) {
      if (m.hedgeContracts > 0) {
        m.btc += hedgePnlBtc(ledger, price, spec) - (m.hedgeContracts * spec.coinContractUsd / price) * spec.futFee
        steps.push({ account: '币本位', text: `BTCUSD **平空 ${m.hedgeContracts} 张**（卖出部分现货后按新持币重开）` })
        m.hedgeContracts = 0
        m.hedgeEntry = 0
      }
      const sell = need / (price * (1 - spec.spotFee))
      m.btc -= sell
      steps.push({ account: '现货', text: `把 ${fmtBtc(sell)} BTC 划回现货账户并 **卖出**（约 ${fmtUsd(need)} USDT）` })
    }
    s.usdt += -delta
    steps.push({ account: '划转', text: `划转 **${fmtUsd(-delta)} USDT** 到 U 本位账户（空单仓）` })
  }

  if (bear) enterShort(ledger, price, spec, steps)
  return { ledger, steps }
}
