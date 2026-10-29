import type {
  Candle,
  ChannelPoint,
  ChannelResult,
  MacdPoint,
  TimeframeStatus,
  TrendState,
} from './types.ts'

/**
 * 指数移动平均。
 *
 * 采用 Pine Script 的 ta.ema 约定：首值直接取源数据首值作为种子，
 * 其后 ema[i] = alpha * src[i] + (1 - alpha) * ema[i-1]，alpha = 2 / (length + 1)。
 */
export function ema(values: number[], length: number): number[] {
  if (length <= 0) throw new Error(`EMA 周期必须为正数，收到 ${length}`)
  const out = new Array<number>(values.length)
  if (values.length === 0) return out

  const alpha = 2 / (length + 1)
  out[0] = values[0]
  for (let i = 1; i < values.length; i++) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
  }
  return out
}

/** 趋势通道的 EMA 周期，对应 Pine 源码中的 32 */
export const CHANNEL_LENGTH = 32

/**
 * 趋势通道。严格对齐 Pine 源码：
 *
 *   stLong  = ta.ema(high, 32)   // 上轨
 *   stShort = ta.ema(low, 32)    // 下轨
 *   多头时：跌破下轨才转空；空头时：突破上轨才转多。
 *
 * 状态是递归的——每根 K 线的状态依赖前一根，因此必须从头顺序推演，
 * 不能只对可视窗口做局部计算。
 */
export function trendChannel(candles: Candle[], length = CHANNEL_LENGTH): ChannelResult {
  if (candles.length === 0) {
    return { points: [], state: 1, pending: false, barsSinceFlip: 0, lastFlipTime: null }
  }

  const upper = ema(candles.map((c) => c.high), length)
  const lower = ema(candles.map((c) => c.low), length)

  const points: ChannelPoint[] = new Array(candles.length)
  // Pine 中 `var int state = 1`，首根默认多头
  let prev: TrendState = 1
  let lastFlipIndex = -1

  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close
    const state: TrendState = prev === 1
      ? (close < lower[i] ? 0 : 1)   // 多头：只有跌破下轨才转空
      : (close > upper[i] ? 1 : 0)   // 空头：只有突破上轨才转多

    const flipped = i > 0 && state !== prev
    if (flipped) lastFlipIndex = i

    points[i] = {
      time: candles[i].time,
      upper: upper[i],
      lower: lower[i],
      // 首根没有前值可比，不算翻转
      flipped,
      state,
    }
    prev = state
  }

  const last = points[points.length - 1]
  const lastCandle = candles[candles.length - 1]

  return {
    points,
    state: last.state,
    // 未收盘 K 线触发的翻转只能算「待确认」
    pending: !lastCandle.closed && last.flipped,
    // 无翻转记录时，视为自首根起一直保持
    barsSinceFlip: lastFlipIndex === -1
      ? candles.length - 1
      : candles.length - 1 - lastFlipIndex,
    lastFlipTime: lastFlipIndex === -1 ? null : candles[lastFlipIndex].time,
  }
}

/**
 * MACD。默认参数 12 / 26 / 9。
 *
 * dif  = EMA(close, fast) - EMA(close, slow)
 * dea  = EMA(dif, signal)
 * hist = (dif - dea) * 2   —— 国内行情软件的惯例，放大两倍便于观察
 */
export function macd(
  candles: Candle[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdPoint[] {
  if (candles.length === 0) return []

  const closes = candles.map((c) => c.close)
  const fastEma = ema(closes, fast)
  const slowEma = ema(closes, slow)
  const dif = fastEma.map((v, i) => v - slowEma[i])
  const dea = ema(dif, signal)

  return candles.map((c, i) => ({
    time: c.time,
    dif: dif[i],
    dea: dea[i],
    hist: (dif[i] - dea[i]) * 2,
  }))
}

/**
 * 价格相对通道的位置，用于状态面板显示「距趋势远近」。
 *
 * 多头看距下轨（跌破即转空）的缓冲，空头看距上轨（突破即转多）的距离。
 * 返回正数表示尚有安全距离，负数表示已越过——正常情况下不会出现。
 */
export function distanceToChannel(close: number, point: ChannelPoint): number {
  const boundary = point.state === 1 ? point.lower : point.upper
  if (boundary === 0) return 0
  const raw = point.state === 1
    ? (close - boundary) / boundary
    : (boundary - close) / boundary
  return raw * 100
}

/** 计算归一化基准时取样的 K 线根数 */
const RANGE_LOOKBACK = 100

/**
 * 该周期近期的平均单根振幅，以百分比计。
 *
 * 用作距离归一化的分母。实测 BTCUSDT 各周期的平均振幅相差约 40 倍
 * （15 分约 0.23%，周线约 9.5%），所以裸百分比在周期之间根本不可比。
 */
export function averageRange(candles: Candle[], lookback = RANGE_LOOKBACK): number {
  if (candles.length === 0) return 0

  const sample = candles.slice(-lookback)
  let sum = 0
  let count = 0

  for (const c of sample) {
    if (c.close === 0) continue
    sum += (c.high - c.low) / c.close
    count++
  }

  return count === 0 ? 0 : (sum / count) * 100
}

/**
 * 把单个周期的行情压成一条可横向对比的状态。
 *
 * 关键是 distanceRatio：距离除以该周期自身的平均振幅，得到「还差几根
 * 普通 K 线的波动就会翻转」。只有这个量在周期之间才有可比性——
 * 实测中周线的 13.98% 折算下来只有 1.48 倍，反而比 4 小时的 2.94%（2.98 倍）更危险。
 */
export function timeframeStatus(candles: Candle[]): TimeframeStatus | null {
  if (candles.length === 0) return null

  const channel = trendChannel(candles)
  const last = candles[candles.length - 1]
  const point = channel.points[channel.points.length - 1]

  const distancePct = distanceToChannel(last.close, point)
  const range = averageRange(candles)

  return {
    state: channel.state,
    distancePct,
    // 振幅为零（停牌或数据异常）时退化为原始百分比，避免除零
    distanceRatio: range === 0 ? distancePct : distancePct / range,
    barsSinceFlip: channel.barsSinceFlip,
    pending: channel.pending,
  }
}
