import type { Candle, Interval } from './types.ts'
import { INTERVAL_MS } from './types.ts'

/**
 * 行情数据源。
 *
 * data-api.binance.vision 是 Binance 官方提供的公开行情镜像，
 * 无需 API key、无鉴权，只读，适合纯前端直连。
 */
const REST_BASE = 'https://data-api.binance.vision'
const WS_BASE = 'wss://stream.binance.com:9443/ws'
/** 组合流端点，一条连接可订阅多个 stream */
const WS_COMBINED = 'wss://stream.binance.com:9443/stream'

/** 单次 REST 请求能拿到的最大 K 线数 */
export const MAX_KLINES = 1000

/** Binance kline 数组的字段位置 */
const K = {
  OpenTime: 0,
  Open: 1,
  High: 2,
  Low: 3,
  Close: 4,
  Volume: 5,
  CloseTime: 6,
} as const

type RawKline = [number, string, string, string, string, string, number, ...unknown[]]

function toCandle(raw: RawKline, now: number): Candle {
  return {
    time: raw[K.OpenTime],
    open: Number(raw[K.Open]),
    high: Number(raw[K.High]),
    low: Number(raw[K.Low]),
    close: Number(raw[K.Close]),
    volume: Number(raw[K.Volume]),
    // REST 只返回已发生的 K 线，最后一根可能仍在进行中
    closed: raw[K.CloseTime] < now,
  }
}

/**
 * 拉取历史 K 线。
 *
 * 默认取满 1000 根：趋势通道的状态机是递归的，必须从足够早的位置起算，
 * 同时 EMA(32) 也需要预热区间。
 */
export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = MAX_KLINES,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const url = `${REST_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
  const res = await fetch(url, { signal })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`拉取 ${symbol} ${interval} 行情失败（HTTP ${res.status}）${detail}`)
  }

  const raw = (await res.json()) as RawKline[]
  const now = Date.now()
  return raw.map((r) => toCandle(r, now))
}

/**
 * 拉取全部 USDT 计价的现货交易对，供添加币种时搜索。
 *
 * 不用 exchangeInfo：全量约 2.5MB，而 ticker/price 只有一百多 KB，
 * 且只列出有报价的交易对，正好排除了已下架的。
 */
export async function fetchUsdtSymbols(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${REST_BASE}/api/v3/ticker/price`, { signal })
  if (!res.ok) throw new Error(`拉取交易对列表失败（HTTP ${res.status}）`)

  const raw = (await res.json()) as { symbol: string; price: string }[]
  return raw
    .filter((t) => t.symbol.endsWith('USDT') && Number(t.price) > 0)
    .map((t) => t.symbol)
    .sort()
}

/** 校验交易对是否存在，用于自定义输入 */
export async function symbolExists(symbol: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${REST_BASE}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    )
    return res.ok
  } catch {
    return false
  }
}

interface KlineMessage {
  k?: {
    t: number
    o: string
    h: string
    l: string
    c: string
    v: string
    x: boolean
  }
}

export interface KlineSocketHandlers {
  /** 收到一根 K 线更新（可能是进行中的最后一根，也可能是刚收盘的新一根） */
  onCandle(candle: Candle): void
  /** 连接状态变化，用于指示灯 */
  onStatus(status: 'connecting' | 'open' | 'reconnecting' | 'closed'): void
  /**
   * 断线重连成功后触发，携带重连期间补齐的 K 线。
   * 调用方据此整体重算，避免状态机因缺口而错位。
   */
  onResync(candles: Candle[]): void
}

/**
 * Binance K 线 WebSocket 客户端。
 *
 * 负责三件事：实时推送、指数退避重连、断线后用 REST 补齐缺口。
 * 补缺口很关键——趋势状态是递归的，漏掉中间的 K 线会让后续状态全错。
 */
export class KlineSocket {
  private ws: WebSocket | null = null
  private retries = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** 最后一次收到数据的 K 线开盘时间，重连后据此判断缺口 */
  private lastTime = 0
  private hadConnection = false

  private readonly symbol: string
  private readonly interval: Interval
  private readonly handlers: KlineSocketHandlers

  constructor(symbol: string, interval: Interval, handlers: KlineSocketHandlers) {
    this.symbol = symbol
    this.interval = interval
    this.handlers = handlers
  }

  connect(): void {
    if (this.disposed) return

    this.handlers.onStatus(this.hadConnection ? 'reconnecting' : 'connecting')

    const stream = `${this.symbol.toLowerCase()}@kline_${this.interval}`
    const ws = new WebSocket(`${WS_BASE}/${stream}`)
    this.ws = ws

    ws.onopen = () => {
      if (this.disposed) return
      this.retries = 0
      this.handlers.onStatus('open')
      // 首次连接无需补缺口；重连则可能错过了若干根
      if (this.hadConnection) void this.resync()
      this.hadConnection = true
    }

    ws.onmessage = (event) => {
      if (this.disposed) return
      let msg: KlineMessage
      try {
        msg = JSON.parse(event.data as string) as KlineMessage
      } catch {
        return
      }
      const k = msg.k
      if (!k) return

      this.lastTime = k.t
      this.handlers.onCandle({
        time: k.t,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        closed: k.x,
      })
    }

    ws.onerror = () => {
      // 错误后紧跟 close 事件，重连逻辑统一放在 onclose
      ws.close()
    }

    ws.onclose = () => {
      if (this.disposed) return
      this.ws = null
      this.scheduleReconnect()
    }
  }

  /** 指数退避：1s、2s、4s…最多 30s，避免断网时疯狂重试 */
  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.retries, 30_000)
    this.retries++
    this.handlers.onStatus('reconnecting')
    this.timer = setTimeout(() => this.connect(), delay)
  }

  /**
   * 重连后补齐缺口。
   *
   * 按断线时长估算缺了多少根，多取一些冗余，交给调用方整体重算。
   */
  private async resync(): Promise<void> {
    if (this.lastTime === 0) return
    const missed = Math.ceil((Date.now() - this.lastTime) / INTERVAL_MS[this.interval])
    // 至少取 2 根（覆盖最后一根未收盘的），上限仍受 REST 限制
    const limit = Math.min(Math.max(missed + 2, 2), MAX_KLINES)

    try {
      const candles = await fetchKlines(this.symbol, this.interval, limit)
      if (!this.disposed) this.handlers.onResync(candles)
    } catch {
      // 补缺口失败不影响实时流，下次重连会再试
    }
  }

  close(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.ws) {
      // 先摘掉回调，避免主动关闭触发重连
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    this.handlers.onStatus('closed')
  }
}

/**
 * 合并一根增量 K 线到已有序列。
 *
 * 同一开盘时间则替换（进行中的 K 线在跳动），时间更新则追加。
 * 返回新数组，便于调用方做不可变更新。
 */
export function mergeCandle(candles: Candle[], incoming: Candle): Candle[] {
  if (candles.length === 0) return [incoming]

  const last = candles[candles.length - 1]
  if (incoming.time === last.time) {
    return [...candles.slice(0, -1), incoming]
  }
  if (incoming.time > last.time) {
    return [...candles, incoming]
  }
  // 迟到的旧数据，忽略
  return candles
}

/**
 * 用补缺口拿到的数据修补序列。
 *
 * 以时间为键覆盖式合并，保证不重复、不缺失、按时间有序。
 */
export function mergeBatch(candles: Candle[], batch: Candle[]): Candle[] {
  if (batch.length === 0) return candles

  const byTime = new Map<number, Candle>()
  for (const c of candles) byTime.set(c.time, c)
  for (const c of batch) byTime.set(c.time, c)

  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

export interface MultiSymbolHandlers {
  /** 某个币种的某个周期收到一根 K 线更新 */
  onCandle(symbol: string, interval: Interval, candle: Candle): void
  /** 连接状态变化 */
  onStatus(status: 'connecting' | 'open' | 'reconnecting' | 'closed'): void
}

interface CombinedMessage {
  stream?: string
  data?: KlineMessage
}

/**
 * 多币种 × 多周期 K 线订阅，走 Binance 组合流。
 *
 * 自选列表每个币要订阅全部五个周期，各开一条 WebSocket 太重，
 * 组合流用一条连接承载全部订阅（单连接上限 1024 路，足够）：
 * wss://.../stream?streams=btcusdt@kline_15m/btcusdt@kline_1h/...
 *
 * 与 KlineSocket 刻意分开：那个服务于主图（需要补缺口、整体重算），
 * 这个只喂边栏（只关心最新价与状态），合并会让两边的重连逻辑互相拖累。
 */
export class MultiSymbolSocket {
  private ws: WebSocket | null = null
  private retries = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private hadConnection = false

  private readonly symbols: readonly string[]
  private readonly intervals: readonly Interval[]
  private readonly handlers: MultiSymbolHandlers

  constructor(
    symbols: readonly string[],
    intervals: readonly Interval[],
    handlers: MultiSymbolHandlers,
  ) {
    this.symbols = symbols
    this.intervals = intervals
    this.handlers = handlers
  }

  connect(): void {
    if (this.disposed) return

    this.handlers.onStatus(this.hadConnection ? 'reconnecting' : 'connecting')

    const streams = this.symbols
      .flatMap((s) => this.intervals.map((iv) => `${s.toLowerCase()}@kline_${iv}`))
      .join('/')
    const ws = new WebSocket(`${WS_COMBINED}?streams=${streams}`)
    this.ws = ws

    ws.onopen = () => {
      if (this.disposed) return
      this.retries = 0
      this.hadConnection = true
      this.handlers.onStatus('open')
    }

    ws.onmessage = (event) => {
      if (this.disposed) return
      let msg: CombinedMessage
      try {
        msg = JSON.parse(event.data as string) as CombinedMessage
      } catch {
        return
      }

      const k = msg.data?.k
      if (!k || !msg.stream) return

      // stream 形如 "btcusdt@kline_4h"，取出币种（还原为大写）与周期
      const [name, kind] = msg.stream.split('@')
      const symbol = name?.toUpperCase()
      const interval = kind?.replace('kline_', '') as Interval | undefined
      if (!symbol || !interval || !this.intervals.includes(interval)) return

      this.handlers.onCandle(symbol, interval, {
        time: k.t,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        closed: k.x,
      })
    }

    ws.onerror = () => ws.close()

    ws.onclose = () => {
      if (this.disposed) return
      this.ws = null
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.retries, 30_000)
    this.retries++
    this.handlers.onStatus('reconnecting')
    this.timer = setTimeout(() => this.connect(), delay)
  }

  close(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }
}

/** 24 小时行情：最新价与涨跌幅 */
export interface Ticker {
  symbol: string
  price: number
  changePct: number
}

/** 批量拉取 24 小时行情，供顶栏价格与币种下拉使用 */
export async function fetchTickers(symbols: readonly string[], signal?: AbortSignal): Promise<Ticker[]> {
  if (symbols.length === 0) return []
  const q = encodeURIComponent(JSON.stringify(symbols))
  const res = await fetch(`${REST_BASE}/api/v3/ticker/24hr?symbols=${q}&type=MINI`, { signal })
  if (!res.ok) throw new Error(`拉取行情失败（HTTP ${res.status}）`)
  const raw = (await res.json()) as { symbol: string; lastPrice: string; openPrice: string }[]
  return raw.map((t) => {
    const price = Number(t.lastPrice)
    const open = Number(t.openPrice)
    return { symbol: t.symbol, price, changePct: open > 0 ? (price / open - 1) * 100 : 0 }
  })
}
