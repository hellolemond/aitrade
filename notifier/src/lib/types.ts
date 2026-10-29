// 拷贝自 hellolemond/t 的 src/lib/types.ts，只保留 Worker 用得到的部分。

/** 支持的时间周期，与 Binance interval 参数一致 */
export type Interval = '15m' | '1h' | '4h' | '1d' | '1w'

/** 一根 K 线。time 为开盘时间（毫秒） */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** 该周期是否已收盘。WebSocket 推送的最后一根通常为 false */
  closed: boolean
}

/** 趋势状态：1 = 多头，0 = 空头。与 Pine 源码的 state 取值一致 */
export type TrendState = 0 | 1

/** 趋势通道在某根 K 线上的计算结果 */
export interface ChannelPoint {
  time: number
  /** 上轨 EMA(high, 32) */
  upper: number
  /** 下轨 EMA(low, 32) */
  lower: number
  state: TrendState
  /** 相对前一根是否发生状态翻转 */
  flipped: boolean
}

/** 趋势通道整体计算结果 */
export interface ChannelResult {
  points: ChannelPoint[]
  /** 最新一根的状态 */
  state: TrendState
  /**
   * 最新状态是否尚未被收盘确认。
   * 当最后一根 K 线未收盘、且它相对前一根发生了翻转时为 true。
   * 对应笔记中「所有价格以周期收盘价为准」的原则。
   */
  pending: boolean
  /**
   * 当前状态已持续多少根 K 线。
   * 刚翻转为 0，用于区分「刚站上」与「站稳很久」——两者对操作的含义完全不同。
   */
  barsSinceFlip: number
  /** 最近一次翻转的时间（毫秒）。无翻转记录时为 null */
  lastFlipTime: number | null
}
