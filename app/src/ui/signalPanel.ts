import { activeStructure } from '../lib/structure.ts'
import {
  INTERVAL_LABELS,
  type Candle,
  type ChannelResult,
  type Interval,
  type PositionAdvice,
  type StructurePoint,
} from '../lib/types.ts'

/**
 * 「长周期」的分界。笔记以日线为界区分大小周期：
 * 日线及以上力度大、影响时间长，之下则相反。
 */
const LONG_INTERVALS: Interval[] = ['1d', '1w']

/** 距趋势「近」的判定阈值，单位是该周期的平均振幅倍数 */
const NEAR_RATIO = 1.5

/**
 * 按笔记附录 A 推导仓位建议。
 *
 * 规则本身很简单，难的是它成立的前提——只有「趋势与结构反向」时才动仓位：
 * 趋势上已经满仓，底部结构买无可买；趋势下已经空仓，顶部结构卖无可卖。
 * 这两种同向情形返回 none，而不是硬凑一个数字出来。
 */
export function advise(
  channel: ChannelResult,
  structure: StructurePoint | null,
  interval: Interval,
  distanceRatio: number,
): PositionAdvice {
  const trendUp = channel.state === 1
  const reasons: string[] = [
    trendUp ? '趋势在上，原则上满仓' : '趋势在下，原则上空仓',
  ]

  if (!structure) {
    return {
      action: 'none',
      tenths: 0,
      summary: trendUp ? '持有，等待顶部结构' : '空仓，等待底部结构',
      reasons: [...reasons, '当前无有效结构信号'],
    }
  }

  const isBottom = structure.type === 'bottom'
  reasons.push(`出现${isBottom ? '底部' : '顶部'}结构（${INTERVAL_LABELS[interval]}）`)

  // 同向结构没有操作空间，这是笔记明确写过的两种「无意义」情形
  if (trendUp && isBottom) {
    return {
      action: 'none',
      tenths: 0,
      summary: '不动 — 趋势上的底部结构买无可买',
      reasons: [...reasons, '已满仓，无仓位可加'],
    }
  }
  if (!trendUp && !isBottom) {
    return {
      action: 'none',
      tenths: 0,
      summary: '不动 — 趋势下的顶部结构卖无可卖',
      reasons: [...reasons, '已空仓，无仓位可减'],
    }
  }

  // 四成权重的二维分配：周期级别 × 距趋势远近
  const isLong = LONG_INTERVALS.includes(interval)
  const isNear = distanceRatio < NEAR_RATIO
  const tenths = (isLong ? 3 : 1) + (isNear ? 1 : 0)

  reasons.push(
    `${isLong ? '长' : '短'}周期 + 距趋势${isNear ? '近' : '远'} → ${tenths} 成`,
  )
  if (structure.pending) {
    reasons.push('该结构形成于未收盘 K 线，需待收盘确认')
  }

  const action = isBottom ? 'buy' : 'sell'
  const summary = isBottom
    ? `买入 ${tenths} 成（趋势下的底部结构，最多 4 成）`
    : `卖出 ${tenths} 成（趋势上的顶部结构，最少留 6 成）`

  return { action, tenths, summary, reasons }
}

/**
 * 顶栏右侧的信号区。
 *
 * 常驻显示：结构信号触发频率很低（实测 BTCUSDT 日线 13 个月只出现 4 次），
 * 多数时候显示的是「持有 / 空仓，等待结构」。这块位置空着反而像布局缺了一块，
 * 而「当前无事可做」本身也是一条有用的结论。
 */
export class SignalPanel {
  private readonly el: HTMLElement

  constructor(root: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'signal is-idle'
    root.appendChild(this.el)
  }

  update(
    candles: Candle[],
    channel: ChannelResult,
    structures: StructurePoint[],
    interval: Interval,
    distanceRatio: number,
  ): void {
    const structure = activeStructure(structures, candles)
    const advice = advise(channel, structure, interval, distanceRatio)
    const variant = signalVariant(advice, structure, channel.state === 1)

    // 第一条理由（趋势在上/下）已体现在徽标与摘要里，副行从结构开始讲
    const detail = [channel.state === 1 ? '趋势在上' : '趋势在下', ...advice.reasons.slice(1)]

    this.el.className = `signal is-${variant.kind}`
    this.el.innerHTML = `
      <span class="signal-text">
        <span class="signal-main">
          <span class="signal-badge">${variant.label}</span>
          <span class="signal-summary">${advice.summary}</span>
        </span>
        <span class="signal-detail">${detail.join(' · ')}</span>
      </span>
      <span class="signal-info" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
      </span>
    `
    this.el.title = advice.reasons.join('\n')
  }
}

interface SignalVariant {
  kind: 'buy' | 'sell' | 'hold' | 'idle' | 'pending'
  label: string
}

/**
 * 把建议映射为五种外观。
 *
 * 待确认单列一种：结构形成于未收盘 K 线时，收盘前随时可能消失，
 * 用和买卖同样醒目的红绿会诱导提前动手。
 */
function signalVariant(
  advice: PositionAdvice,
  structure: StructurePoint | null,
  trendUp: boolean,
): SignalVariant {
  if (advice.action !== 'none' && structure?.pending) return { kind: 'pending', label: '待确认' }
  if (advice.action === 'buy') return { kind: 'buy', label: '买入' }
  if (advice.action === 'sell') return { kind: 'sell', label: '卖出' }
  if (structure) return { kind: 'hold', label: '不动' }
  return { kind: 'idle', label: trendUp ? '持有' : '空仓' }
}
