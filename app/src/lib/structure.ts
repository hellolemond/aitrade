import { macd } from './indicators.ts'
import {
  DEFAULT_SWING_WINDOW,
  type Candle,
  type StructurePoint,
  type StructureType,
  type SwingWindow,
} from './types.ts'

/**
 * 摆动高低点。
 *
 * 判定标准：左右各 window 根之内没有更极端的值。
 * 这对应笔记里「两波同向行情中间至少要有两个以上反向角线隔开」——
 * 窗口保证了两个同向极值之间确实存在足够的反向波动。
 *
 * window 是全模块最敏感的参数：实测 BTCUSDT 400 根日线上，
 * 取 3 / 5 / 8 分别得到 2 / 4 / 2 次结构。笔记第四篇也明确提醒过
 * 指标跨市场移植需要重新回溯优化，所以它开放给使用者调整。
 */
export function swingPoints(
  values: number[],
  window: number,
  kind: 'low' | 'high',
): number[] {
  const out: number[] = []
  if (values.length < window * 2 + 1) return out

  const isBetter = kind === 'low'
    ? (a: number, b: number) => a < b
    : (a: number, b: number) => a > b

  for (let i = window; i < values.length - window; i++) {
    let extreme = true
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue
      if (isBetter(values[j], values[i])) {
        extreme = false
        break
      }
    }
    if (extreme) out.push(i)
  }
  return out
}

/** 钝化区间内所需的最少反向柱数，对应笔记的「2 根负脚线」 */
const MIN_OPPOSITE_BARS = 2

/**
 * 相邻两个摆动点之间的最小间隔。
 *
 * 太近的两个极值算同一波行情，比对它们没有意义。
 */
const MIN_SWING_GAP = 4

/**
 * 识别结构。
 *
 * 严格按笔记第六篇的三阶段定义：
 *
 * 1. 钝化：价格创新低而 DIF 不创新低（顶部结构反之），
 *    且区间内出现至少 2 根负柱。钝化是一种**状态**。
 * 2. 结构形成：钝化发生后 DIF 拐头的那一**刻**。
 * 3. 纠错：钝化消失，即 DIF 跌破前锋值（顶部则升破）。
 *
 * 三个阶段严格有序：没有钝化就没有钝化消失，没有形成过的结构也无所谓纠错。
 * 钝化在形成之前就被打破的，整段作废、不产生任何标记——它从未走到第二步。
 *
 * 所有判断以收盘价为准——只有周期走完收盘价才写死，对应指标值也才写死。
 * 最后一根未收盘时触发的结构标记为 pending，与趋势通道的处理保持一致。
 */
export function structurePoints(
  candles: Candle[],
  window: SwingWindow = DEFAULT_SWING_WINDOW,
  maxAgeBars = MAX_STRUCTURE_AGE_BARS,
): StructurePoint[] {
  if (candles.length < window * 2 + 2) return []

  const macdPoints = macd(candles)
  const dif = macdPoints.map((p) => p.dif)
  const hist = macdPoints.map((p) => p.hist)

  const bottoms = detect(candles, dif, hist, window, 'bottom', maxAgeBars)
  const tops = detect(candles, dif, hist, window, 'top', maxAgeBars)

  return [...bottoms, ...tops].sort((a, b) => a.dullTo - b.dullTo)
}

function detect(
  candles: Candle[],
  dif: number[],
  hist: number[],
  window: number,
  type: StructureType,
  maxAgeBars: number,
): StructurePoint[] {
  const isBottom = type === 'bottom'
  const prices = candles.map((c) => (isBottom ? c.low : c.high))
  const swings = swingPoints(prices, window, isBottom ? 'low' : 'high')

  const out: StructurePoint[] = []

  for (let i = 1; i < swings.length; i++) {
    const from = swings[i - 1]
    const to = swings[i]
    if (to - from < MIN_SWING_GAP) continue

    // 钝化的核心：价格更极端，但 DIF 没有跟上——动能与价格不同步
    const priceExtends = isBottom ? prices[to] < prices[from] : prices[to] > prices[from]
    const difLags = isBottom ? dif[to] > dif[from] : dif[to] < dif[from]
    if (!priceExtends || !difLags) continue

    // 区间内要有足够的反向柱，排除只是轻微回踩的情形
    let opposite = 0
    for (let j = from; j <= to; j++) {
      if (isBottom ? hist[j] < 0 : hist[j] > 0) opposite++
    }
    if (opposite < MIN_OPPOSITE_BARS) continue

    const point: StructurePoint = {
      type,
      dullFrom: from,
      dullTo: to,
      dullFromTime: candles[from].time,
      dullToTime: candles[to].time,
      formedIndex: null,
      formedTime: null,
      invalidatedIndex: null,
      invalidatedTime: null,
      pending: false,
    }

    /**
     * 前锋值取钝化**起点**的 DIF，而不是终点的。
     *
     * 钝化之所以成立，是因为 dif[dullTo] 高于 dif[dullFrom]（底部结构）——
     * 价格创了新低而 DIF 没有。那么「钝化消失」自然就是 DIF 跌回
     * dif[dullFrom] 之下：此刻 DIF 也确认了新低，背离不复存在。
     *
     * 若误取终点的 DIF 作前锋值，由于 MACD 天然滞后于价格，
     * 摆动低点之后 DIF 几乎总会先微跌一格，会导致每个结构都在
     * 形成之前就被判定纠错。
     */
    const frontier = dif[from]

    /**
     * 扫描从摆动点被**确认**的那根开始，而不是紧跟 dullTo。
     *
     * swingPoints 要求右侧 window 根内没有更极端的值，所以 dullTo 这个
     * 摆动点要到 dullTo + window 才能被认出来。若从 dullTo + 1 起扫，
     * 程序会在自己尚未发现这段钝化的时刻就判它形成或纠错——回溯时看着合理，
     * 实盘上却是拿未来数据做的决定，不可交易。
     */
    const start = to + window + 1

    for (let j = start; j < candles.length; j++) {
      const dullGone = isBottom ? dif[j] < frontier : dif[j] > frontier

      if (point.formedIndex === null) {
        // 还没形成就钝化消失：这段背离夭折了，整段作废。
        // 纠错是第三阶段，前提是走完了第二阶段——没形成过的结构谈不上纠错。
        if (dullGone) {
          point.formedIndex = null
          break
        }

        // 结构形成：DIF 拐头的那一刻
        const turned = isBottom ? dif[j] > dif[j - 1] : dif[j] < dif[j - 1]
        if (turned) {
          point.formedIndex = j
          point.formedTime = candles[j].time
          point.pending = !candles[j].closed
        }
        continue
      }

      // 超出影响期仍未纠错的，按过期处理：不打纠错标记。
      // frontier 是个绝对水平、永不过期，几百根之后市场自然涨回该位置就会
      // 误触发纠错，把一个早已与当下无关的结构重新摆到图上。
      if (j - point.formedIndex > maxAgeBars) break

      if (dullGone) {
        point.invalidatedIndex = j
        point.invalidatedTime = candles[j].time
        break
      }
    }

    // 形成前即夭折的钝化不进入结果集
    if (point.formedIndex === null) continue

    out.push(point)
  }

  return out
}

/**
 * 结构的影响期上限，单位为 K 线根数。
 *
 * 取 100 而非笔记提到的 24，依据是对 8 个币种 × 5 个周期的实测：
 * 「最新活跃结构的年龄」呈明显双峰——近期的落在 5~87 根，陈旧的落在
 * 117~293 根，中间 87→117 是空档。100 落在这条缝里。
 *
 * 关键观察是这条断层出现在**相近的根数**上而非相近的时长上：
 * 周线的陈旧结构与 15 分的陈旧结构都在 100+ 根，尽管一个是两年、
 * 一个是一天。指标活在 K 线空间而非钟表空间，所以用单一常数而不按周期分档。
 *
 * 该值在 90~115 区间内结果完全一致（附近样本只有 84、87、117 三点），
 * 不敏感意味着取值不必纠结。
 *
 * 原先的 24 过紧：3 个币种 × 5 个周期的抽样中，「形成→纠错」的自然存活期
 * 中位数为 29/37/57/63/33 根，全部高于 24，导致 60~82% 的结构在指标
 * 自身的退出标准（纠错）之前就被掐掉。
 *
 * 注意本上限并非对所有周期都放行：4 小时周期实测的活跃结构年龄是
 * 161/162 根，在 100 之下同样被滤掉——它们确实属于「陈旧」那一簇，
 * 这是预期行为而非调参不足。
 *
 * 样本为单一时间点快照（n=26），换市场阶段后断层位置可能漂移；
 * 好在参数在有用区间内不敏感，漂移几十根不改变结果。
 */
export const MAX_STRUCTURE_AGE_BARS = 100

/**
 * 当前仍然有效的结构。
 *
 * 「有效」指已经形成、尚未被纠错、且仍在影响期内。结构只提供买入（卖出）
 * 标准与纠错标准，不构成交易闭环——它必须配合趋势使用，这是笔记反复强调的。
 */
export function activeStructure(
  points: StructurePoint[],
  candles: Candle[],
  maxAgeBars = MAX_STRUCTURE_AGE_BARS,
): StructurePoint | null {
  if (candles.length === 0) return null
  const lastIndex = candles.length - 1

  // 必须按 formedIndex 而非数组顺序找最近的一个：
  // structurePoints 的返回值按 dullTo 排序，而底部与顶部两组结构的
  // 钝化终点与形成时刻并非同序——dullTo 更早的结构完全可能更晚形成。
  let latest: StructurePoint | null = null

  for (const p of points) {
    if (p.formedIndex === null) continue
    if (p.invalidatedIndex !== null) continue
    if (lastIndex - p.formedIndex > maxAgeBars) continue
    if (latest === null || p.formedIndex > latest.formedIndex!) latest = p
  }

  return latest
}
