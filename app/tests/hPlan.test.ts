import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFlip, initLedger, rebalance, valuation, BTC_SPEC } from '../src/lib/hPlan.ts'

const T = 1_793_145_600_000

test('初始化（空头）：主仓留 USDT，空单仓按 1x 开空并向下取整到 0.001', () => {
  const { ledger, steps } = initLedger(4000, 0, 79_842, T, 2026)
  assert.equal(ledger.main.usdt, 2800)
  assert.equal(ledger.main.btc, 0)
  assert.equal(ledger.sleeve.shortQty, 0.015)
  // 名义价值不超过空单仓资金（1 倍）
  assert.ok(ledger.sleeve.shortQty * 79_842 <= 1200)
  assert.ok(steps.some((s) => s.account === 'U本位' && s.text.includes('开空 0.015')))
})

test('初始化（多头）：主仓买入现货，空单仓持有 USDT', () => {
  const { ledger } = initLedger(4000, 1, 80_000, T, 2026)
  assert.equal(ledger.main.usdt, 0)
  assert.ok(Math.abs(ledger.main.btc - 2800 * 0.999 / 80_000) < 1e-12)
  assert.equal(ledger.sleeve.shortQty, 0)
  assert.equal(ledger.sleeve.usdt, 1200)
})

test('转多：平掉空单仓空单，主仓用 USDT 买入', () => {
  const init = initLedger(4000, 0, 80_000, T, 2026).ledger
  const { ledger, steps } = applyFlip(init, 1, 84_000)
  assert.equal(ledger.state, 1)
  assert.equal(ledger.sleeve.shortQty, 0)
  // 空单在上涨中亏损：0.014 × (80000 − 84000) = −56，再扣手续费
  const expected = 1200 - 0.014 * 80_000 * 0.0005 + 0.014 * (80_000 - 84_000) - 0.014 * 84_000 * 0.0005
  assert.ok(Math.abs(ledger.sleeve.usdt - expected) < 1e-9)
  assert.ok(ledger.main.btc > 0)
  assert.equal(ledger.main.usdt, 0)
  assert.equal(steps.length, 2)
})

test('转空：主仓按持币开币本位空单（张数向下取整），空单仓开空', () => {
  const long = initLedger(4000, 1, 80_000, T, 2026).ledger
  const { ledger } = applyFlip(long, 0, 90_000)
  // 持币约 0.034965 BTC × 90000 ≈ 3146.9 美元 → 31 张
  assert.equal(ledger.main.hedgeContracts, 31)
  assert.equal(ledger.main.hedgeEntry, 90_000)
  assert.equal(ledger.sleeve.shortQty, 0.013)
})

test('套利腿锁定价值：空头期间价格涨跌，主仓美元估值几乎不变', () => {
  const long = initLedger(4000, 1, 80_000, T, 2026).ledger
  const short = applyFlip(long, 0, 90_000).ledger
  const at = (p: number) => valuation(short, p, BTC_SPEC).main
  const unhedged = short.main.btc * 90_000 - 31 * 100   // 不足一张的零头仍随价格波动
  for (const p of [60_000, 90_000, 120_000]) {
    const drift = Math.abs(at(p) - at(90_000))
    assert.ok(drift <= Math.abs(unhedged * (p / 90_000 - 1)) + 1e-6, `价格 ${p} 时偏移 ${drift}`)
  }
})

test('币本位平空盈亏以 BTC 结算：下跌后转多，BTC 数量增加', () => {
  const long = initLedger(4000, 1, 80_000, T, 2026).ledger
  const short = applyFlip(long, 0, 90_000).ledger
  const back = applyFlip(short, 1, 60_000).ledger
  assert.ok(back.main.btc > short.main.btc * 1.3)
  assert.equal(back.main.hedgeContracts, 0)
})

test('翻转方向与账本一致时不产生操作', () => {
  const init = initLedger(4000, 0, 80_000, T, 2026).ledger
  const r = applyFlip(init, 0, 70_000)
  assert.equal(r.steps.length, 0)
  assert.deepEqual(r.ledger, init)
})

test('再平衡：主仓涨多了，划一部分到空单仓，比例回到 70:30', () => {
  const long = initLedger(4000, 1, 80_000, T, 2026).ledger
  const { ledger, steps } = rebalance(long, 120_000, 2027)
  const v = valuation(ledger, 120_000)
  assert.ok(Math.abs(v.main / v.total - 0.7) < 0.002, `主仓占比 ${v.main / v.total}`)
  assert.equal(ledger.lastRebalanceYear, 2027)
  assert.ok(steps.some((s) => s.account === '现货' && s.text.includes('卖出')))
})

test('再平衡：空头期空单仓赚多了，划回主仓后按新资金重开空单', () => {
  const init = initLedger(4000, 0, 80_000, T, 2026).ledger
  const { ledger } = rebalance(init, 50_000, 2027)
  const v = valuation(ledger, 50_000)
  assert.ok(Math.abs(v.main / v.total - 0.7) < 0.005)
  assert.ok(ledger.sleeve.shortQty > 0)
  assert.equal(ledger.sleeve.shortEntry, 50_000)
})

test('再平衡：偏差小于 1% 时不调整', () => {
  const init = initLedger(4000, 0, 80_000, T, 2026).ledger
  const { steps, ledger } = rebalance(init, 80_100, 2027)
  assert.equal(steps.length, 1)
  assert.ok(steps[0].text.includes('不调整'))
  assert.equal(ledger.sleeve.shortQty, init.sleeve.shortQty)
})
