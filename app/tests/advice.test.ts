import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise } from '../src/ui/signalPanel.ts'
import type { ChannelResult, StructurePoint } from '../src/lib/types.ts'

function channel(state: 0 | 1): ChannelResult {
  return {
    points: [{ time: 0, upper: 120, lower: 100, state, flipped: false }],
    state,
    pending: false,
    barsSinceFlip: 10,
    lastFlipTime: null,
  }
}

function structure(type: 'bottom' | 'top', pending = false): StructurePoint {
  return {
    type,
    dullFrom: 0,
    dullTo: 5,
    dullFromTime: 0,
    dullToTime: 5,
    formedIndex: 6,
    formedTime: 6,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending,
  }
}

test('advise：无结构时趋势上为持有', () => {
  const a = advise(channel(1), null, '1d', 2)
  assert.equal(a.action, 'none')
  assert.equal(a.tenths, 0)
})

test('advise：无结构时趋势下为空仓等待', () => {
  const a = advise(channel(0), null, '1d', 2)
  assert.equal(a.action, 'none')
  assert.match(a.summary, /空仓/)
})

test('advise：趋势上的底部结构买无可买', () => {
  const a = advise(channel(1), structure('bottom'), '1d', 1)
  assert.equal(a.action, 'none')
  assert.equal(a.tenths, 0)
})

test('advise：趋势下的顶部结构卖无可卖', () => {
  const a = advise(channel(0), structure('top'), '1d', 1)
  assert.equal(a.action, 'none')
  assert.equal(a.tenths, 0)
})

test('advise：趋势下 + 日线底部结构 + 距近 = 买 4 成', () => {
  const a = advise(channel(0), structure('bottom'), '1d', 1.0)
  assert.equal(a.action, 'buy')
  assert.equal(a.tenths, 4)
})

test('advise：趋势下 + 日线底部结构 + 距远 = 买 3 成', () => {
  const a = advise(channel(0), structure('bottom'), '1d', 3.0)
  assert.equal(a.action, 'buy')
  assert.equal(a.tenths, 3)
})

test('advise：趋势下 + 60分底部结构 + 距近 = 买 2 成', () => {
  const a = advise(channel(0), structure('bottom'), '1h', 1.0)
  assert.equal(a.action, 'buy')
  assert.equal(a.tenths, 2)
})

test('advise：趋势下 + 60分底部结构 + 距远 = 买 1 成', () => {
  const a = advise(channel(0), structure('bottom'), '1h', 3.0)
  assert.equal(a.action, 'buy')
  assert.equal(a.tenths, 1)
})

test('advise：趋势上 + 顶部结构 = 卖出', () => {
  const a = advise(channel(1), structure('top'), '1d', 1.0)
  assert.equal(a.action, 'sell')
  assert.equal(a.tenths, 4)
})

test('advise：周线归入长周期', () => {
  const a = advise(channel(0), structure('bottom'), '1w', 1.0)
  assert.equal(a.tenths, 4)
})

test('advise：15分归入短周期', () => {
  const a = advise(channel(0), structure('bottom'), '15m', 1.0)
  assert.equal(a.tenths, 2)
})

test('advise：仓位成数永不超过 4', () => {
  for (const iv of ['15m', '1h', '4h', '1d', '1w'] as const) {
    for (const ratio of [0, 0.5, 1.4, 1.6, 10]) {
      const a = advise(channel(0), structure('bottom'), iv, ratio)
      assert.ok(a.tenths <= 4, `${iv} ${ratio} 得到 ${a.tenths} 成`)
    }
  }
})

test('advise：未收盘形成的结构会在依据中提示', () => {
  const a = advise(channel(0), structure('bottom', true), '1d', 1.0)
  assert.ok(a.reasons.some((r) => r.includes('待收盘确认')))
})

test('advise：依据中always包含趋势状态', () => {
  const up = advise(channel(1), null, '1d', 2)
  const down = advise(channel(0), null, '1d', 2)
  assert.ok(up.reasons[0].includes('趋势在上'))
  assert.ok(down.reasons[0].includes('趋势在下'))
})
