import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, closeDate, closeYear, detect, reconcile, type DailySignal, type Holdings } from '../src/lib/hStrategy.ts'

const empty = (): Holdings => ({
  spot: { usdt: 0, btc: 0 },
  coinM: { walletBtc: 0, unrealizedBtc: 0, contracts: 0, entry: 0 },
  usdM: { walletUsdt: 0, unrealizedUsdt: 0, shortQty: 0, entry: 0 },
})

// 2026-10-28 00:00 UTC 开盘的日线，北京时间 10-29 08:00 收盘
const T = Date.UTC(2026, 9, 28)

const sig = (state: 0 | 1, over: Partial<DailySignal> = {}): DailySignal => ({
  state, candleTime: T, close: 80_105, upper: 82_712, lower: 80_718,
  flipTime: T, flipClose: 80_105, barsSinceFlip: 0, ...over,
})

test('closeDate / closeYear 按北京时间收盘日计算', () => {
  assert.equal(closeDate(T), '10-29')
  assert.equal(closeYear(Date.UTC(2026, 11, 31)), 2027)
})

test('空头、只有 USDT：U 本位开空 0.014，主仓 USDT 不动', () => {
  const h = empty()
  h.spot.usdt = 2800
  h.usdM.walletUsdt = 1200
  const steps = reconcile(0, h, 80_105)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].account, 'U本位')
  assert.match(steps[0].text, /开空 0\.014 BTC/)
})

test('空头、持币：现货 BTC 先划转，币本位按总持币开空', () => {
  const h = empty()
  h.spot.btc = 0.01
  h.coinM.walletBtc = 0.025
  h.usdM.walletUsdt = 1200
  const steps = reconcile(0, h, 80_105)
  assert.deepEqual(steps.map((s) => s.account), ['划转', '币本位', 'U本位'])
  assert.match(steps[1].text, /开空 28 张/)   // 0.035 × 80105 / 100 = 28.04
})

test('空头、已对冲：持仓符合目标时没有操作，张数差 1 以内不提示', () => {
  const h = empty()
  h.coinM.walletBtc = 0.035
  h.coinM.contracts = 27
  h.coinM.entry = 80_105
  h.usdM.walletUsdt = 1199
  h.usdM.shortQty = 0.014
  assert.deepEqual(reconcile(0, h, 80_105), [])
  h.coinM.contracts = 20
  assert.match(reconcile(0, h, 80_105)[0].text, /加空 8 张/)
})

test('多头：平掉两边空单，USDT 买入', () => {
  const h = empty()
  h.spot.usdt = 2800
  h.coinM.contracts = 28
  h.usdM.walletUsdt = 1200
  h.usdM.shortQty = 0.014
  const steps = reconcile(1, h, 90_000)
  assert.deepEqual(steps.map((s) => s.account), ['币本位', '现货', 'U本位'])
  assert.deepEqual(reconcile(1, { ...empty(), coinM: { walletBtc: 0.03, unrealizedBtc: 0, contracts: 0, entry: 0 } }, 90_000), [])
})

test('未设置 Key 时给出通用步骤', () => {
  assert.equal(reconcile(0, null, 80_000).length, 2)
  assert.equal(reconcile(1, null, 80_000).length, 3)
})

test('detect：首次运行只记录进度，不生成记录', () => {
  const d = detect(sig(0), null, null)!
  assert.equal(d.tasks.length, 0)
  assert.equal(d.state.state, 0)
  assert.equal(d.state.lastRebalanceYear, 2026)
})

test('detect：同一根日线不重复处理；新日线无翻转只推进进度', () => {
  const stored = { state: 0, lastCandleTime: T, lastRebalanceYear: 2026 }
  assert.equal(detect(sig(0), stored, null), null)
  const d = detect(sig(0, { candleTime: T + DAY_MS }), stored, null)!
  assert.equal(d.tasks.length, 0)
  assert.equal(d.state.lastCandleTime, T + DAY_MS)
})

test('detect：翻转生成记录并取代旧的未完成记录', () => {
  const stored = { state: 0, lastCandleTime: T - DAY_MS, lastRebalanceYear: 2026 }
  const d = detect(sig(1), stored, null)!
  assert.equal(d.tasks.length, 1)
  assert.equal(d.tasks[0].title, '转多')
  assert.equal(d.tasks[0].supersede, true)
  assert.equal(d.state.state, 1)
})

test('detect：跨年生成再平衡', () => {
  const t = Date.UTC(2026, 11, 31)
  const stored = { state: 1, lastCandleTime: t - DAY_MS, lastRebalanceYear: 2026 }
  const h = empty()
  h.coinM.walletBtc = 0.05
  h.usdM.walletUsdt = 1000
  const d = detect(sig(1, { candleTime: t, close: 100_000 }), stored, h)!
  assert.equal(d.tasks.length, 1)
  assert.equal(d.tasks[0].kind, 'rebalance')
  assert.equal(d.state.lastRebalanceYear, 2027)
  assert.ok(d.tasks[0].steps.some((s) => s.text.includes('卖出')))
})

test('空头、已有 U 本位空单：数量差一整步才提示，超过 1 倍提示平掉多余', () => {
  const h = empty()
  h.spot.usdt = 1400
  h.usdM.walletUsdt = 599.75
  h.usdM.entry = 79_817.7
  h.usdM.shortQty = 0.007
  assert.deepEqual(reconcile(0, h, 80_242), [])          // 当前持仓
  h.usdM.shortQty = 0.005
  assert.match(reconcile(0, h, 80_242)[0].text, /加空 0\.002/)
  h.usdM.shortQty = 0.012
  assert.match(reconcile(0, h, 80_242)[0].text, /平空 0\.005/)
})

test('出现多单：先平多', () => {
  const h = empty()
  h.usdM.walletUsdt = 600
  h.usdM.shortQty = -0.003
  h.usdM.entry = 80_000
  const steps = reconcile(0, h, 80_000)
  assert.match(steps[0].text, /平多 0\.003/)
  assert.match(steps[1].text, /开空 0\.007/)
  h.usdM.shortQty = 0
  h.coinM.contracts = -5
  assert.match(reconcile(1, h, 80_000)[0].text, /平多 5 张/)
})
