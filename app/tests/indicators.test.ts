import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ema,
  trendChannel,
  macd,
  distanceToChannel,
  averageRange,
  timeframeStatus,
} from '../src/lib/indicators.ts'
import { nearnessLevel } from '../src/lib/types.ts'
import type { Candle } from '../src/lib/types.ts'

/** 构造测试用 K 线。默认 high/low 围绕 close 展开 */
function candle(
  i: number,
  close: number,
  high = close + 1,
  low = close - 1,
  closed = true,
): Candle {
  return { time: i * 60_000, open: close, high, low, close, volume: 0, closed }
}

test('ema：首值取源数据首值作为种子', () => {
  const out = ema([10, 20, 30], 3)
  assert.equal(out[0], 10)
})

test('ema：恒定序列的 EMA 恒等于该常数', () => {
  const out = ema([5, 5, 5, 5, 5], 4)
  for (const v of out) assert.equal(v, 5)
})

test('ema：按 alpha = 2/(n+1) 递推', () => {
  const out = ema([10, 20], 3) // alpha = 0.5
  assert.equal(out[1], 0.5 * 20 + 0.5 * 10)
})

test('ema：周期非正数时抛错', () => {
  assert.throws(() => ema([1, 2, 3], 0))
})

test('ema：空数组返回空数组', () => {
  assert.deepEqual(ema([], 32), [])
})

test('trendChannel：空输入返回默认多头且无待确认', () => {
  const r = trendChannel([])
  assert.deepEqual(r.points, [])
  assert.equal(r.state, 1)
  assert.equal(r.pending, false)
})

test('trendChannel：初始状态为多头', () => {
  const r = trendChannel([candle(0, 100)])
  assert.equal(r.points[0].state, 1)
})

test('trendChannel：首根不标记翻转', () => {
  const r = trendChannel([candle(0, 100)])
  assert.equal(r.points[0].flipped, false)
})

test('trendChannel：持续上涨维持多头', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100 + i * 2))
  const r = trendChannel(candles)
  assert.equal(r.state, 1)
})

test('trendChannel：收盘跌破下轨转空头', () => {
  // 先横盘让 EMA 收敛，再一根深跌砸穿下轨
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))
  const r = trendChannel(candles)
  assert.equal(r.state, 0)
  assert.equal(r.points[60].flipped, true)
})

test('trendChannel：多头状态下仅收盘价跌破才转空，下影线不算', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  // 最低价远低于下轨，但收盘仍在轨上 —— 不应转空
  candles.push(candle(60, 100, 101, 50))
  const r = trendChannel(candles)
  assert.equal(r.state, 1)
})

test('trendChannel：空头状态下未突破上轨则维持空头', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))   // 转空
  candles.push(candle(61, 60, 61, 59))   // 反弹但未破上轨
  const r = trendChannel(candles)
  assert.equal(r.state, 0)
  assert.equal(r.points[61].flipped, false)
})

test('trendChannel：空头突破上轨转回多头', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))    // 转空
  candles.push(candle(61, 300, 301, 299)) // 暴涨突破上轨
  const r = trendChannel(candles)
  assert.equal(r.state, 1)
  assert.equal(r.points[61].flipped, true)
})

test('trendChannel：状态递归——中途的翻转会影响后续判断', () => {
  // 同一组价格，若状态机不递归而是逐根独立判断，末尾状态会不同
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100))
  candles.push(candle(40, 50, 51, 49))  // 转空，此后 EMA 下移
  // 缓慢回升，始终不突破上轨 → 应全程维持空头
  for (let i = 41; i < 50; i++) candles.push(candle(i, 55 + (i - 41), 56 + (i - 41), 54 + (i - 41)))
  const r = trendChannel(candles)
  assert.equal(r.state, 0)
  assert.equal(r.points.slice(41).every((p) => p.state === 0), true)
})

test('trendChannel：上轨始终不低于下轨', () => {
  const candles = Array.from({ length: 80 }, (_, i) => candle(i, 100 + Math.sin(i) * 20))
  const r = trendChannel(candles)
  for (const p of r.points) assert.ok(p.upper >= p.lower, `upper ${p.upper} < lower ${p.lower}`)
})

test('trendChannel：每根 K 线都有对应输出点且时间对齐', () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, 100 + i))
  const r = trendChannel(candles)
  assert.equal(r.points.length, candles.length)
  r.points.forEach((p, i) => assert.equal(p.time, candles[i].time))
})

test('trendChannel：未收盘 K 线触发的翻转标记为待确认', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49, false)) // 未收盘且翻转
  const r = trendChannel(candles)
  assert.equal(r.state, 0)
  assert.equal(r.pending, true)
})

test('trendChannel：已收盘 K 线触发的翻转不算待确认', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49, true))
  const r = trendChannel(candles)
  assert.equal(r.pending, false)
})

test('trendChannel：未收盘但无翻转时不算待确认', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 101, 102, 100, false))
  const r = trendChannel(candles)
  assert.equal(r.pending, false)
})

test('macd：空输入返回空数组', () => {
  assert.deepEqual(macd([]), [])
})

test('macd：恒定价格下 dif 与柱状值归零', () => {
  const candles = Array.from({ length: 50 }, (_, i) => candle(i, 100))
  const out = macd(candles)
  const last = out[out.length - 1]
  assert.ok(Math.abs(last.dif) < 1e-9)
  assert.ok(Math.abs(last.hist) < 1e-9)
})

test('macd：持续上涨时 dif 为正', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100 + i * 3))
  const out = macd(candles)
  assert.ok(out[out.length - 1].dif > 0)
})

test('macd：柱状值等于 (dif - dea) * 2', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100 + i * 3))
  const out = macd(candles)
  const p = out[out.length - 1]
  assert.ok(Math.abs(p.hist - (p.dif - p.dea) * 2) < 1e-9)
})

test('macd：输出长度与时间轴对齐', () => {
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 + i))
  const out = macd(candles)
  assert.equal(out.length, candles.length)
  out.forEach((p, i) => assert.equal(p.time, candles[i].time))
})

test('distanceToChannel：多头时衡量距下轨的缓冲', () => {
  const d = distanceToChannel(110, { time: 0, upper: 120, lower: 100, state: 1, flipped: false })
  assert.ok(Math.abs(d - 10) < 1e-9)
})

test('distanceToChannel：空头时衡量距上轨的距离', () => {
  const d = distanceToChannel(110, { time: 0, upper: 120, lower: 100, state: 0, flipped: false })
  assert.ok(Math.abs(d - (10 / 120) * 100) < 1e-9)
})

test('distanceToChannel：边界为零时返回零而非 NaN', () => {
  const d = distanceToChannel(110, { time: 0, upper: 0, lower: 0, state: 1, flipped: false })
  assert.equal(d, 0)
})

test('trendChannel：刚翻转时持续根数为 0', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))
  const r = trendChannel(candles)
  assert.equal(r.barsSinceFlip, 0)
})

test('trendChannel：翻转后持续根数随 K 线累加', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))          // 翻空
  candles.push(candle(61, 52, 53, 51))          // +1
  candles.push(candle(62, 53, 54, 52))          // +2
  const r = trendChannel(candles)
  assert.equal(r.state, 0)
  assert.equal(r.barsSinceFlip, 2)
})

test('trendChannel：记录最近一次翻转的时间', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))
  candles.push(candle(61, 52, 53, 51))
  const r = trendChannel(candles)
  assert.equal(r.lastFlipTime, 60 * 60_000)
})

test('trendChannel：从未翻转时时间为 null、根数为全长', () => {
  const candles = Array.from({ length: 30 }, (_, i) => candle(i, 100 + i))
  const r = trendChannel(candles)
  assert.equal(r.lastFlipTime, null)
  assert.equal(r.barsSinceFlip, 29)
})

test('trendChannel：多次翻转只记最后一次', () => {
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100))
  candles.push(candle(40, 50, 51, 49))           // 翻空
  candles.push(candle(41, 300, 301, 299))        // 翻多
  candles.push(candle(42, 305, 306, 304))
  const r = trendChannel(candles)
  assert.equal(r.state, 1)
  assert.equal(r.barsSinceFlip, 1)
  assert.equal(r.lastFlipTime, 41 * 60_000)
})

test('averageRange：空数组返回 0', () => {
  assert.equal(averageRange([]), 0)
})

test('averageRange：恒定振幅下等于该振幅百分比', () => {
  // high-low = 2，close = 100 → 2%
  const candles = Array.from({ length: 50 }, (_, i) => candle(i, 100, 101, 99))
  assert.ok(Math.abs(averageRange(candles) - 2) < 1e-9)
})

test('averageRange：只取最近 lookback 根', () => {
  const candles = [
    ...Array.from({ length: 50 }, (_, i) => candle(i, 100, 120, 80)),   // 振幅大，应被排除
    ...Array.from({ length: 10 }, (_, i) => candle(50 + i, 100, 101, 99)),
  ]
  assert.ok(Math.abs(averageRange(candles, 10) - 2) < 1e-9)
})

test('averageRange：跳过收盘价为零的异常数据', () => {
  const candles = [
    candle(0, 100, 101, 99),
    { time: 60_000, open: 0, high: 0, low: 0, close: 0, volume: 0, closed: true },
  ]
  assert.ok(Number.isFinite(averageRange(candles)))
  assert.ok(Math.abs(averageRange(candles) - 2) < 1e-9)
})

test('timeframeStatus：空数组返回 null', () => {
  assert.equal(timeframeStatus([]), null)
})

test('timeframeStatus：归一化倍数等于距离除以平均振幅', () => {
  const candles = Array.from({ length: 80 }, (_, i) => candle(i, 100 + i * 0.5))
  const s = timeframeStatus(candles)!
  const expected = s.distancePct / averageRange(candles)
  assert.ok(Math.abs(s.distanceRatio - expected) < 1e-9)
})

test('timeframeStatus：振幅为零时退化为原始百分比而非 NaN', () => {
  // high = low = close，振幅恒为 0
  const candles = Array.from({ length: 50 }, (_, i) => candle(i, 100, 100, 100))
  const s = timeframeStatus(candles)!
  assert.ok(Number.isFinite(s.distanceRatio))
  assert.equal(s.distanceRatio, s.distancePct)
})

test('timeframeStatus：同样的距离百分比在高波动周期下危险度更高', () => {
  // 两组末值相同的数据，仅振幅不同
  const calm = Array.from({ length: 80 }, (_, i) => candle(i, 100 + i * 0.5, 100 + i * 0.5 + 0.2, 100 + i * 0.5 - 0.2))
  const wild = Array.from({ length: 80 }, (_, i) => candle(i, 100 + i * 0.5, 100 + i * 0.5 + 5, 100 + i * 0.5 - 5))
  const a = timeframeStatus(calm)!
  const b = timeframeStatus(wild)!
  // 振幅越大，同等距离折算出的倍数越小（越危险）
  assert.ok(b.distanceRatio < a.distanceRatio)
})

test('timeframeStatus：透传多空状态与持续根数', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  candles.push(candle(60, 50, 51, 49))
  candles.push(candle(61, 52, 53, 51))
  const s = timeframeStatus(candles)!
  assert.equal(s.state, 0)
  assert.equal(s.barsSinceFlip, 1)
})

test('nearnessLevel：不足 1 倍振幅为临界', () => {
  assert.equal(nearnessLevel(0.4), 'critical')
  assert.equal(nearnessLevel(0.99), 'critical')
})

test('nearnessLevel：1 至 3 倍为常态', () => {
  assert.equal(nearnessLevel(1), 'normal')
  assert.equal(nearnessLevel(2.9), 'normal')
})

test('nearnessLevel：3 倍以上为稳固', () => {
  assert.equal(nearnessLevel(3), 'solid')
  assert.equal(nearnessLevel(12), 'solid')
})
