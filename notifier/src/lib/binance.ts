// 拷贝自 hellolemond/t 的 src/lib/binance.ts，只保留 REST 拉取 K 线的部分。
import type { Candle, Interval } from './types.ts'

/**
 * 行情数据源。
 *
 * data-api.binance.vision 是 Binance 官方提供的公开行情镜像，
 * 无需 API key、无鉴权，只读。
 */
const REST_BASE = 'https://data-api.binance.vision'

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
