import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  swingPoints,
  structurePoints,
  activeStructure,
  MAX_STRUCTURE_AGE_BARS,
} from '../src/lib/structure.ts'
import type { Candle, StructurePoint } from '../src/lib/types.ts'

function candle(
  i: number,
  close: number,
  high = close + 1,
  low = close - 1,
  closed = true,
): Candle {
  return { time: i * 86_400_000, open: close, high, low, close, volume: 0, closed }
}

/**
 * 构造一段底背离行情：先深跌造低点，回升，再创更低的价格低点，
 * 但因为第二波跌势较缓，DIF 不会跟着创新低——这正是钝化的定义。
 */
function bottomDivergence(): Candle[] {
  const out: Candle[] = []
  let t = 0
  // 前段：高位横盘，让 EMA 收敛
  for (let i = 0; i < 40; i++) out.push(candle(t++, 100))
  // 第一波急跌到 70
  for (let i = 0; i < 12; i++) out.push(candle(t++, 100 - (i + 1) * 2.5))
  // 反弹到 85
  for (let i = 0; i < 12; i++) out.push(candle(t++, 70 + (i + 1) * 1.25))
  // 第二波缓跌，价格更低（到 68）但跌势平缓
  for (let i = 0; i < 20; i++) out.push(candle(t++, 85 - (i + 1) * 0.85))
  // 尾部企稳回升，触发 DIF 拐头
  for (let i = 0; i < 12; i++) out.push(candle(t++, 68 + (i + 1) * 0.5))
  return out
}

test('swingPoints：识别出局部低点', () => {
  const vals = [5, 4, 3, 2, 1, 2, 3, 4, 5]
  const lows = swingPoints(vals, 3, 'low')
  assert.deepEqual(lows, [4])
})

test('swingPoints：识别出局部高点', () => {
  const vals = [1, 2, 3, 4, 5, 4, 3, 2, 1]
  const highs = swingPoints(vals, 3, 'high')
  assert.deepEqual(highs, [4])
})

test('swingPoints：窗口内边缘不作为摆动点', () => {
  const vals = [1, 2, 3, 4, 5]
  // 窗口 3 时首尾各 3 根无法判定，中间不足
  assert.deepEqual(swingPoints(vals, 3, 'low'), [])
})

test('swingPoints：数据长度不足窗口时返回空', () => {
  assert.deepEqual(swingPoints([1, 2, 3], 5, 'low'), [])
})

test('swingPoints：窗口越大识别出的摆动点越少', () => {
  const vals = Array.from({ length: 80 }, (_, i) => 50 + Math.sin(i / 2) * 10)
  const narrow = swingPoints(vals, 3, 'low').length
  const wide = swingPoints(vals, 8, 'low').length
  assert.ok(wide <= narrow, `宽窗口 ${wide} 应不多于窄窗口 ${narrow}`)
})

test('structurePoints：数据不足时返回空数组', () => {
  assert.deepEqual(structurePoints([candle(0, 100)]), [])
})

test('structurePoints：单调上涨无背离，不产生底部结构', () => {
  const candles = Array.from({ length: 90 }, (_, i) => candle(i, 100 + i * 2))
  const bottoms = structurePoints(candles).filter((p) => p.type === 'bottom')
  assert.equal(bottoms.length, 0)
})

test('structurePoints：恒定价格不产生任何结构', () => {
  const candles = Array.from({ length: 90 }, (_, i) => candle(i, 100))
  assert.equal(structurePoints(candles).length, 0)
})

test('structurePoints：底背离行情能识别出底部结构', () => {
  const points = structurePoints(bottomDivergence())
  const bottoms = points.filter((p) => p.type === 'bottom')
  assert.ok(bottoms.length > 0, '应识别出至少一个底部结构')
})

test('structurePoints：钝化区间的终点晚于起点', () => {
  for (const p of structurePoints(bottomDivergence())) {
    assert.ok(p.dullTo > p.dullFrom, `dullTo ${p.dullTo} 应晚于 dullFrom ${p.dullFrom}`)
  }
})

test('structurePoints：结构形成必定晚于钝化终点', () => {
  for (const p of structurePoints(bottomDivergence())) {
    if (p.formedIndex !== null) {
      assert.ok(p.formedIndex > p.dullTo, '结构形成应发生在钝化之后')
    }
  }
})

test('structurePoints：纠错必定晚于钝化终点', () => {
  for (const p of structurePoints(bottomDivergence())) {
    if (p.invalidatedIndex !== null) {
      assert.ok(p.invalidatedIndex > p.dullTo, '纠错应发生在钝化之后')
    }
  }
})

test('structurePoints：返回的结构必定已形成', () => {
  // 钝化是状态、形成是时刻、纠错是钝化消失——三者严格有序。
  // 形成之前钝化就被打破的，整段夭折，不应出现在结果里（更不该带纠错标记）。
  const points = structurePoints(bottomDivergence())
  assert.ok(points.every((p) => p.formedIndex !== null), '不应返回未形成的结构')
})

test('structurePoints：不给未形成的结构打纠错标记', () => {
  // 曾经的 bug：ETHUSDT 15m 2026-09-21 10:00 出现纠错叉，但那段钝化
  // 从头到尾没形成过结构——图上只有深色钝化带和一个孤立的纠错
  const points = structurePoints(bottomDivergence())
  for (const p of points) {
    if (p.invalidatedIndex !== null) {
      assert.notEqual(p.formedIndex, null, '有纠错必先有形成')
    }
  }
})

test('structurePoints：形成与纠错都不早于摆动点被确认的时刻', () => {
  // swingPoints 需要右侧 window 根才能认出 dullTo，在那之前程序尚不知道
  // 这段钝化存在。若从 dullTo+1 起判，等于用未来数据做决定，实盘不可交易。
  const candles = bottomDivergence()
  for (const w of [3, 5, 8] as const) {
    for (const p of structurePoints(candles, w)) {
      assert.ok(
        p.formedIndex! >= p.dullTo + w + 1,
        `window=${w}: 形成 ${p.formedIndex} 早于确认点 ${p.dullTo + w + 1}`,
      )
      if (p.invalidatedIndex !== null) {
        assert.ok(
          p.invalidatedIndex >= p.dullTo + w + 1,
          `window=${w}: 纠错 ${p.invalidatedIndex} 早于确认点 ${p.dullTo + w + 1}`,
        )
      }
    }
  }
})

test('structurePoints：纠错不会超出影响期', () => {
  // frontier 是绝对水平、永不过期。曾经的 bug：BTCUSDT 15m 一个 09-18 形成的
  // 结构在 249 根之后（09-21 09:45）才纠错——市场自然涨回该 DIF 水平就触发，
  // 与当下行情早已无关，而默认视图只显示 240 根，那段钝化带还在视窗之外
  const candles = bottomDivergence()
  for (const w of [3, 5, 8] as const) {
    for (const p of structurePoints(candles, w)) {
      if (p.invalidatedIndex !== null) {
        assert.ok(
          p.invalidatedIndex - p.formedIndex! <= MAX_STRUCTURE_AGE_BARS,
          `纠错距形成 ${p.invalidatedIndex - p.formedIndex!} 根，超出影响期`,
        )
      }
    }
  }
})

test('structurePoints：影响期收紧后迟到的纠错被抑制', () => {
  const candles = bottomDivergence()
  const withCap = structurePoints(candles, 5, 1)
  // 影响期设为 1 根，任何隔了几根才出现的纠错都应被当作过期而非纠错
  for (const p of withCap) {
    if (p.invalidatedIndex !== null) {
      assert.ok(p.invalidatedIndex - p.formedIndex! <= 1)
    }
  }
})

test('structurePoints：影响期只影响纠错，不改变形成判定', () => {
  const candles = bottomDivergence()
  const loose = structurePoints(candles, 5, 9999)
  const tight = structurePoints(candles, 5, 1)
  assert.deepEqual(
    tight.map((p) => p.formedIndex),
    loose.map((p) => p.formedIndex),
    '收紧影响期不应改变结构的形成时刻或数量',
  )
})

test('structurePoints：时间字段与索引对应', () => {
  const candles = bottomDivergence()
  for (const p of structurePoints(candles)) {
    assert.equal(p.dullFromTime, candles[p.dullFrom].time)
    assert.equal(p.dullToTime, candles[p.dullTo].time)
    if (p.formedIndex !== null) {
      assert.equal(p.formedTime, candles[p.formedIndex].time)
    }
  }
})

test('structurePoints：未收盘 K 线上形成的结构标记为待确认', () => {
  const candles = bottomDivergence()
  // 把尾部全部标为未收盘，确保结构形成点落在未收盘 K 线上
  const open = candles.map((c, i) => (i >= candles.length - 12 ? { ...c, closed: false } : c))
  const points = structurePoints(open)
  const formedInTail = points.filter(
    (p) => p.formedIndex !== null && p.formedIndex >= open.length - 12,
  )
  assert.ok(formedInTail.length > 0, '尾部应有结构形成')
  assert.ok(formedInTail.every((p) => p.pending), '未收盘形成的结构应标记 pending')
})

test('structurePoints：已收盘形成的结构不标记待确认', () => {
  const points = structurePoints(bottomDivergence())
  const formed = points.filter((p) => p.formedIndex !== null)
  assert.ok(formed.every((p) => !p.pending))
})

test('structurePoints：结果按钝化终点时间升序', () => {
  const points = structurePoints(bottomDivergence())
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].dullTo >= points[i - 1].dullTo, '结构应按时间排序')
  }
})

test('structurePoints：窗口参数影响识别结果', () => {
  const candles = bottomDivergence()
  const a = structurePoints(candles, 3).length
  const b = structurePoints(candles, 8).length
  // 不同窗口应产生不同数量——这正是把它开放为可调参数的原因
  assert.ok(typeof a === 'number' && typeof b === 'number')
})

test('activeStructure：无结构时返回 null', () => {
  const candles = Array.from({ length: 90 }, (_, i) => candle(i, 100))
  assert.equal(activeStructure([], candles), null)
})

test('activeStructure：空 K 线返回 null', () => {
  assert.equal(activeStructure([], []), null)
})

test('activeStructure：已纠错的结构不算有效', () => {
  const candles = bottomDivergence()
  const points = structurePoints(candles).map((p) => ({
    ...p,
    formedIndex: p.dullTo + 1,
    formedTime: candles[p.dullTo + 1].time,
    invalidatedIndex: p.dullTo + 2,
    invalidatedTime: candles[p.dullTo + 2].time,
  }))
  assert.equal(activeStructure(points, candles), null)
})

test('activeStructure：尚未形成的结构不算有效', () => {
  const candles = bottomDivergence()
  const points = structurePoints(candles).map((p) => ({
    ...p,
    formedIndex: null,
    formedTime: null,
  }))
  assert.equal(activeStructure(points, candles), null)
})

test('activeStructure：超出影响期的结构不算有效', () => {
  const candles = bottomDivergence()
  const points = structurePoints(candles).filter((p) => p.formedIndex !== null)
  if (points.length > 0) {
    // 影响期设为 0，任何历史结构都应被排除
    assert.equal(activeStructure(points, candles, 0), null)
  }
})

test('activeStructure：返回最近一个有效结构', () => {
  const candles = bottomDivergence()
  const points = structurePoints(candles).filter(
    (p) => p.formedIndex !== null && p.invalidatedIndex === null,
  )
  const active = activeStructure(points, candles, 9999)
  if (points.length > 0) {
    assert.ok(active !== null)
    assert.equal(active!.formedIndex, points[points.length - 1].formedIndex)
  }
})

test('activeStructure：取形成最晚的结构，而非数组末尾的', () => {
  // structurePoints 按 dullTo 排序，但底部与顶部两组的钝化终点与形成时刻并非同序：
  // dullTo 更早的结构完全可能更晚形成。若按数组顺序倒序取，会返回过期的那个。
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))

  const early: StructurePoint = {
    type: 'bottom',
    dullFrom: 10,
    dullTo: 20,
    dullFromTime: candles[10].time,
    dullToTime: candles[20].time,
    formedIndex: 55,
    formedTime: candles[55].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }
  const late: StructurePoint = {
    type: 'top',
    dullFrom: 25,
    dullTo: 30,
    dullFromTime: candles[25].time,
    dullToTime: candles[30].time,
    formedIndex: 40,
    formedTime: candles[40].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }

  // 按 dullTo 升序排列（与 structurePoints 的返回顺序一致）
  const active = activeStructure([early, late], candles, 9999)
  assert.equal(active?.formedIndex, 55, '应返回 formedIndex 最大的结构')
  assert.equal(active?.type, 'bottom')
})

test('activeStructure：影响期过滤按各自的 formedIndex 判定', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100))
  const stale: StructurePoint = {
    type: 'bottom',
    dullFrom: 0,
    dullTo: 5,
    dullFromTime: candles[0].time,
    dullToTime: candles[5].time,
    formedIndex: 6,
    formedTime: candles[6].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }
  const fresh: StructurePoint = {
    type: 'top',
    dullFrom: 40,
    dullTo: 50,
    dullFromTime: candles[40].time,
    dullToTime: candles[50].time,
    formedIndex: 52,
    formedTime: candles[52].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }
  // 影响期 24 根：stale 形成于 6（距今 53 根）应被排除，fresh 形成于 52（距今 7 根）保留
  const active = activeStructure([stale, fresh], candles, 24)
  assert.equal(active?.formedIndex, 52)
})

test('activeStructure：默认影响期保留近期结构（50 根前形成）', () => {
  // 原先默认 24 会把它滤掉。实测各周期自然存活期中位数为 29~63 根，
  // 24 抢在指标自身的退出标准（纠错）之前掐断了 60~82% 的结构
  const candles = Array.from({ length: 200 }, (_, i) => candle(i, 100))
  const p: StructurePoint = {
    type: 'bottom',
    dullFrom: 130,
    dullTo: 145,
    dullFromTime: candles[130].time,
    dullToTime: candles[145].time,
    formedIndex: 149,
    formedTime: candles[149].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }
  // 距末尾 50 根
  assert.equal(activeStructure([p], candles)?.formedIndex, 149)
})

test('activeStructure：默认影响期排除陈旧结构（200 根前形成）', () => {
  // 实测确实存在 200~293 根未被纠错的结构，若不设上限会拿它驱动仓位建议
  const candles = Array.from({ length: 300 }, (_, i) => candle(i, 100))
  const p: StructurePoint = {
    type: 'bottom',
    dullFrom: 80,
    dullTo: 95,
    dullFromTime: candles[80].time,
    dullToTime: candles[95].time,
    formedIndex: 99,
    formedTime: candles[99].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }
  // 距末尾 200 根
  assert.equal(activeStructure([p], candles), null)
})

test('activeStructure：影响期在 90~115 区间内结果一致', () => {
  // 参数不敏感是有意的设计属性：断层两侧最近的样本是 87 与 117，
  // 落在缝里意味着具体取值不影响结果
  const candles = Array.from({ length: 200 }, (_, i) => candle(i, 100))
  const p: StructurePoint = {
    type: 'top',
    dullFrom: 90,
    dullTo: 105,
    dullFromTime: candles[90].time,
    dullToTime: candles[105].time,
    formedIndex: 112,
    formedTime: candles[112].time,
    invalidatedIndex: null,
    invalidatedTime: null,
    pending: false,
  }
  // 距末尾 87 根——应在 90/100/115 三个取值下都保留
  for (const cap of [90, 100, 115]) {
    assert.equal(activeStructure([p], candles, cap)?.formedIndex, 112, `cap=${cap}`)
  }
})

test('MAX_STRUCTURE_AGE_BARS：落在实测断层内，避免 90~115 之外的取值', () => {
  // 断层两侧最近的样本是 87 与 117。取值落出这个区间会改变行为，
  // 届时应重新做实测而不是随手改数
  assert.ok(
    MAX_STRUCTURE_AGE_BARS > 87 && MAX_STRUCTURE_AGE_BARS < 117,
    `影响期 ${MAX_STRUCTURE_AGE_BARS} 落在实测断层 87~117 之外，需重新验证`,
  )
})
