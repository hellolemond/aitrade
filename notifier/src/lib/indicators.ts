// 拷贝自 hellolemond/t 的 src/lib/indicators.ts，只保留 ema 与 trendChannel。
import type { Candle, ChannelPoint, ChannelResult, TrendState } from './types.ts'

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

