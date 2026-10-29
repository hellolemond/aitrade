import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCandle, mergeBatch } from '../src/lib/binance.ts'
import type { Candle } from '../src/lib/types.ts'

function candle(time: number, close: number, closed = true): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 0, closed }
}

test('mergeCandle：空序列直接收下新 K 线', () => {
  const out = mergeCandle([], candle(100, 10))
  assert.equal(out.length, 1)
  assert.equal(out[0].close, 10)
})

test('mergeCandle：同一开盘时间则替换（进行中的 K 线在跳动）', () => {
  const base = [candle(100, 10), candle(200, 20, false)]
  const out = mergeCandle(base, candle(200, 25, false))
  assert.equal(out.length, 2)
  assert.equal(out[1].close, 25)
})

test('mergeCandle：时间更新则追加新一根', () => {
  const base = [candle(100, 10), candle(200, 20)]
  const out = mergeCandle(base, candle(300, 30, false))
  assert.equal(out.length, 3)
  assert.equal(out[2].time, 300)
})

test('mergeCandle：忽略迟到的旧数据', () => {
  const base = [candle(100, 10), candle(200, 20)]
  const out = mergeCandle(base, candle(150, 15))
  assert.equal(out.length, 2)
  assert.equal(out[1].time, 200)
})

test('mergeCandle：不修改原数组', () => {
  const base = [candle(100, 10)]
  mergeCandle(base, candle(200, 20))
  assert.equal(base.length, 1)
})

test('mergeBatch：空批次原样返回', () => {
  const base = [candle(100, 10)]
  assert.equal(mergeBatch(base, []), base)
})

test('mergeBatch：补齐断线期间缺失的 K 线', () => {
  const base = [candle(100, 10), candle(200, 20)]
  const batch = [candle(300, 30), candle(400, 40)]
  const out = mergeBatch(base, batch)
  assert.deepEqual(out.map((c) => c.time), [100, 200, 300, 400])
})

test('mergeBatch：重叠部分以新数据为准', () => {
  const base = [candle(100, 10), candle(200, 20, false)]
  const batch = [candle(200, 22), candle(300, 30)]
  const out = mergeBatch(base, batch)
  assert.equal(out.length, 3)
  assert.equal(out[1].close, 22)
  assert.equal(out[1].closed, true)
})

test('mergeBatch：结果始终按时间升序', () => {
  const base = [candle(300, 30), candle(100, 10)]
  const batch = [candle(200, 20)]
  const out = mergeBatch(base, batch)
  assert.deepEqual(out.map((c) => c.time), [100, 200, 300])
})

test('mergeBatch：不产生重复时间戳', () => {
  const base = [candle(100, 10), candle(200, 20)]
  const batch = [candle(100, 11), candle(200, 21)]
  const out = mergeBatch(base, batch)
  assert.equal(out.length, 2)
})
