/** 支持的时间周期，与 Binance interval 参数一致 */
export type Interval = '5m' | '15m' | '1h' | '4h' | '1d' | '1w'

export const INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d', '1w']

export const INTERVAL_LABELS: Record<Interval, string> = {
  '5m': '5分',
  '15m': '15分',
  '1h': '1小时',
  '4h': '4小时',
  '1d': '日线',
  '1w': '周线',
}

/** 各周期的毫秒长度，用于判断 K 线是否已收盘、补缺口 */
export const INTERVAL_MS: Record<Interval, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
}

/** 自选列表的初始内容，用户增删后以本地数据库为准 */
export const DEFAULT_WATCHLIST = ['BTCUSDT']

/** 列表上显示的简称，去掉 USDT 后缀 */
export function shortSymbol(symbol: string): string {
  return symbol.replace(/USDT$/, '')
}

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

/**
 * 单个周期的完整状态，供多周期状态条使用。
 *
 * 只给多空方向是不够的：15 分的「多」与周线的「多」在操作上天差地别，
 * 必须同时给出「离翻转还有多远」和「已经持续多久」。
 */
export interface TimeframeStatus {
  state: TrendState
  /** 距翻转边界的原始百分比。多头看距下轨，空头看距上轨 */
  distancePct: number
  /**
   * 距离以该周期自身波动幅度归一化后的倍数。
   *
   * 裸百分比在周期间不可比——15 分的 1% 是常态波动，周线的 1% 则很罕见。
   * 这个值回答的是「相对该周期而言，这个距离算不算近」，是横向对比的唯一依据。
   */
  distanceRatio: number
  /** 当前状态已持续的 K 线根数 */
  barsSinceFlip: number
  /** 状态是否尚未由收盘确认 */
  pending: boolean
}

/** 距离危险分级，用于配色与共振判定 */
export type NearnessLevel = 'critical' | 'normal' | 'solid'

/**
 * 按归一化倍数分级。
 *
 * 阈值以「该周期平均振幅的多少倍」为单位：
 * 不足 1 倍意味着一根普通 K 线的波动就足以触发翻转。
 */
export function nearnessLevel(ratio: number): NearnessLevel {
  if (ratio < 1) return 'critical'
  if (ratio < 3) return 'normal'
  return 'solid'
}

/** MACD 计算结果，用于副图与后续的「结构/钝化」判断 */
export interface MacdPoint {
  time: number
  dif: number
  dea: number
  hist: number
}

/** 连接状态，用于右上角指示灯 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** 结构类型。底部结构看反弹，顶部结构看回落 */
export type StructureType = 'bottom' | 'top'

/**
 * 摆动点识别窗口的可选档位。实测改变它会显著改变结构数量。
 * 界面上不再提供切换，仅保留 URL 第三段（`#BTCUSDT/4h/8`）用于回溯验证。
 */
export const SWING_WINDOWS = [3, 5, 8] as const

export type SwingWindow = (typeof SWING_WINDOWS)[number]

export const DEFAULT_SWING_WINDOW: SwingWindow = 5

/**
 * 一次完整的结构事件。
 *
 * 对应笔记第六篇的三个阶段：钝化（一段状态）→ 结构形成（一个时刻）→ 纠错（钝化消失）。
 * 三者共用一条记录，因为它们描述的是同一段行情的不同阶段。
 */
export interface StructurePoint {
  type: StructureType
  /** 钝化区间起点（前一个摆动点）的 K 线索引 */
  dullFrom: number
  /** 钝化区间终点（形成背离的那个摆动点）的 K 线索引 */
  dullTo: number
  /** 钝化区间终点的时间，用于在副图画背景带 */
  dullFromTime: number
  dullToTime: number
  /** 结构形成的 K 线索引。尚未形成时为 null */
  formedIndex: number | null
  /** 结构形成的时间。尚未形成时为 null */
  formedTime: number | null
  /** 纠错（钝化消失）的 K 线索引。未纠错时为 null */
  invalidatedIndex: number | null
  invalidatedTime: number | null
  /** 结构形成于尚未收盘的 K 线，需待收盘确认 */
  pending: boolean
}

/** 仓位建议。对应笔记附录 A 的规则表 */
export interface PositionAdvice {
  /** 操作方向。none 表示当前无需动作 */
  action: 'buy' | 'sell' | 'none'
  /** 建议动用的仓位成数（0-4）。趋势本身决定的 10 成不在此列 */
  tenths: number
  /** 一句话结论，直接可读 */
  summary: string
  /** 推导依据，逐条列出 */
  reasons: string[]
}
