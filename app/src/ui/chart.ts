import {
  CandlestickSeries,
  createTextWatermark,
  type ITextWatermarkPluginApi,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { ChannelBandSeries, type ChannelBandData } from './channelBand.ts'
import { macd, trendChannel } from '../lib/indicators.ts'
import { structurePoints } from '../lib/structure.ts'
import {
  DEFAULT_SWING_WINDOW,
  type Candle,
  type ChannelResult,
  type Interval,
  type StructurePoint,
  type SwingWindow,
} from '../lib/types.ts'

/**
 * 配色按 TradingView 官方默认值：
 * - K 线用 TradingView 的红 #EF5350 / 绿 #26A69A，默认红涨绿跌；MACD 用蓝 / 橙线，
 *   柱子跟随 K 线涨跌色并分深浅；
 * - 趋势通道沿用 Pine 脚本的 color.red / color.green：多头段红、空头段绿，
 *   轨道线按每一段的状态着色；翻转标记转多用 color.lime、转空用 color.red。
 */
export const COLORS = {
  bull: '#f23645',
  bear: '#4caf50',
  flipUp: '#00e676',
  flipDown: '#f23645',
  /** K 线默认红涨绿跌，可在基础设置里修改 */
  candleUp: '#ef5350',
  candleDown: '#26a69a',
  dif: '#2962ff',
  dea: '#ff6d00',
  grid: 'rgba(42, 46, 57, 0.06)',
  text: '#787b86',
  border: '#e0e3eb',
  background: '#fffdeb',
  /** 水印：与 TradingView 米色主题下的灰字一致 */
  watermark: 'rgba(120, 123, 134, 0.26)',
} as const

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function alpha(hex: string, a: number): string {
  return `rgba(${rgb(hex).join(', ')}, ${a})`
}

/** 与白色（t > 0）或黑色（t < 0）混合，得到同色系的浅色 / 深色 */
function mix(hex: string, t: number): string {
  const target = t > 0 ? 255 : 0
  const k = Math.abs(t)
  const [r, g, b] = rgb(hex).map((c) => Math.round(c + (target - c) * k))
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** 由涨跌色派生 MACD 四色柱（同 TradingView：远离零轴深、回收浅）与钝化加深色 */
function palette(up: string, down: string) {
  return {
    up,
    down,
    upLight: mix(up, 0.65),
    downLight: mix(down, 0.65),
    upDeep: mix(up, -0.35),
    downDeep: mix(down, -0.35),
  }
}

const WATERMARK_INTERVAL: Record<Interval, string> = {
  '5m': '5分钟',
  '15m': '15分钟',
  '1h': '1小时',
  '4h': '4小时',
  '1d': '1天',
  '1w': '1周',
}

const sec = (ms: number) => (ms / 1000) as UTCTimestamp

/** 图表渲染所需的一次性计算结果 */
export interface RenderPayload {
  candles: Candle[]
  channel: ChannelResult
  structures: StructurePoint[]
}

export function computeAll(
  candles: Candle[],
  swingWindow: SwingWindow = DEFAULT_SWING_WINDOW,
): RenderPayload {
  return {
    candles,
    channel: trendChannel(candles),
    structures: structurePoints(candles, swingWindow),
  }
}

/**
 * 主图表。封装 K 线、趋势通道（双轨 + 填充 + 翻转标记）与 MACD 副图。
 *
 * 切换周期或币种时调用 setData 整体重绘；WebSocket 推送时调用 updateLast 局部更新。
 */
export class TrendChart {
  private readonly chart: IChartApi
  private readonly candleSeries: ISeriesApi<'Candlestick'>
  private readonly upperSeries: ISeriesApi<'Line'>
  private readonly lowerSeries: ISeriesApi<'Line'>
  private readonly bandSeries: ISeriesApi<'Custom'>
  private readonly difSeries: ISeriesApi<'Line'>
  private readonly deaSeries: ISeriesApi<'Line'>
  private readonly histSeries: ISeriesApi<'Histogram'>
  private readonly markers: ISeriesMarkersPluginApi<Time>
  private readonly watermark: ITextWatermarkPluginApi<Time>
  private label: { symbol: string; interval: Interval } | null = null
  /** K 线涨跌色，可在设置里修改；MACD 柱与结构标记跟随 */
  private candle = palette(COLORS.candleUp, COLORS.candleDown)
  private last: RenderPayload | null = null
  private width = 0
  private readonly resizeObserver: ResizeObserver
  /** 首次加载需要 fitContent，之后切换要保留用户的缩放位置 */
  private firstRender = true

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      layout: {
        background: { color: COLORS.background },
        textColor: COLORS.text,
        fontFamily: "'Inter', -apple-system, 'PingFang SC', sans-serif",
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: COLORS.border, separatorHoverColor: '#b2b5be' },
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: 'rgba(26,29,35,0.32)', width: 1, style: 2, labelBackgroundColor: '#131722' },
        horzLine: { color: 'rgba(26,29,35,0.32)', width: 1, style: 2, labelBackgroundColor: '#131722' },
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (p: number) => formatPrice(p),
      },
      autoSize: false,
    })

    // 填充层最先加入，确保被 K 线与轨道线覆盖
    this.bandSeries = this.chart.addCustomSeries(new ChannelBandSeries(), {
      bullColor: alpha(COLORS.bull, 0.2),
      bearColor: alpha(COLORS.bear, 0.2),
      priceLineVisible: false,
      lastValueVisible: false,
    })

    this.upperSeries = this.chart.addSeries(LineSeries, {
      color: COLORS.bull,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    this.lowerSeries = this.chart.addSeries(LineSeries, {
      color: COLORS.bull,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    this.candleSeries = this.chart.addSeries(CandlestickSeries, {
      upColor: COLORS.candleUp,
      downColor: COLORS.candleDown,
      borderUpColor: COLORS.candleUp,
      borderDownColor: COLORS.candleDown,
      wickUpColor: COLORS.candleUp,
      wickDownColor: COLORS.candleDown,
      priceLineWidth: 1,
      priceLineStyle: 2,
    })

    this.markers = createSeriesMarkers(this.candleSeries, [])

    // MACD 副图：pane 1
    this.histSeries = this.chart.addSeries(
      HistogramSeries,
      { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } },
      1,
    )
    this.difSeries = this.chart.addSeries(
      LineSeries,
      { color: COLORS.dif, lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
      1,
    )
    this.deaSeries = this.chart.addSeries(
      LineSeries,
      { color: COLORS.dea, lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
      1,
    )

    const panes = this.chart.panes()
    if (panes.length > 1) {
      panes[0].setStretchFactor(72)
      panes[1].setStretchFactor(28)
    }

    // 水印放在主图正中央，渲染在所有 series 之下，不遮挡 K 线
    this.watermark = createTextWatermark(panes[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: [],
    })

    this.resizeObserver = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = container
      if (clientWidth > 0 && clientHeight > 0) {
        this.chart.resize(clientWidth, clientHeight)
        if (Math.abs(clientWidth - this.width) > 20) {
          this.width = clientWidth
          this.applyWatermark()
        }
      }
    })
    this.resizeObserver.observe(container)
    this.chart.resize(container.clientWidth, container.clientHeight)
    this.width = container.clientWidth
  }

  /** 修改 K 线涨跌色：K 线、MACD 柱、结构标记随之重绘 */
  setCandleColors(up: string, down: string): void {
    this.candle = palette(up, down)
    this.candleSeries.applyOptions({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    })
    if (this.last) {
      const keep = this.firstRender
      this.firstRender = false
      this.setData(this.last)
      this.firstRender = keep
    }
  }

  /** 水印：大字「BTCUSDT, 1天」，下面一行「BTC / USDT」，同 TradingView。字号随图表宽度缩放 */
  setLabel(symbol: string, interval: Interval): void {
    this.label = { symbol, interval }
    this.applyWatermark()
  }

  private applyWatermark(): void {
    if (!this.label) return
    const { symbol, interval } = this.label
    const big = Math.round(Math.max(36, Math.min(110, this.width / 10)))
    const small = Math.round(big / 2)
    this.watermark.applyOptions({
      lines: [
        { text: `${symbol}, ${WATERMARK_INTERVAL[interval]}`, color: COLORS.watermark, fontSize: big, lineHeight: big * 1.1 },
        { text: `${symbol.replace(/USDT$/, '')} / USDT`, color: COLORS.watermark, fontSize: small, lineHeight: small * 1.4 },
      ],
    })
  }

  /** 整体重绘。切换周期、币种、或断线补齐后调用 */
  setData(payload: RenderPayload): void {
    const { candles, channel, structures } = payload
    if (candles.length === 0) return
    this.last = payload

    const candleData: CandlestickData<Time>[] = candles.map((c) => ({
      time: sec(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
    this.candleSeries.setData(candleData)

    const upper: LineData<Time>[] = []
    const lower: LineData<Time>[] = []
    const band: ChannelBandData[] = []

    for (const p of channel.points) {
      const t = sec(p.time)
      const color = p.state === 1 ? COLORS.bull : COLORS.bear
      upper.push({ time: t, value: p.upper, color })
      lower.push({ time: t, value: p.lower, color })
      band.push({ time: t, upper: p.upper, lower: p.lower, state: p.state })
    }

    this.upperSeries.setData(upper)
    this.lowerSeries.setData(lower)
    this.bandSeries.setData(band)
    this.applyMarkers(candles, channel, structures)

    const macdPoints = macd(candles)
    this.difSeries.setData(macdPoints.map((p) => ({ time: sec(p.time), value: p.dif })))
    this.deaSeries.setData(macdPoints.map((p) => ({ time: sec(p.time), value: p.dea })))

    // 钝化区间画在 MACD 副图：钝化的定义就是 DIF 与价格背离，
    // 画在价格图上说不清，画在 DIF 所在的副图才对得上
    const dullBars = new Map<number, 'bottom' | 'top'>()
    for (const s of structures) {
      for (let i = s.dullFrom; i <= s.dullTo; i++) {
        dullBars.set(candles[i]?.time ?? -1, s.type)
      }
    }

    this.histSeries.setData(
      macdPoints.map<HistogramData<Time>>((p, i) => {
        const dull = dullBars.get(p.time)
        const prev = macdPoints[i - 1]?.hist ?? p.hist
        const up = p.hist >= 0
        // 与 TradingView 一致：柱子离零轴越来越远用深色，往回收用浅色。
        // 钝化区间另用更深的颜色，红绿仍由柱子自身的正负决定
        const color = dull
          ? (up ? this.candle.upDeep : this.candle.downDeep)
          : up
            ? (p.hist >= prev ? this.candle.up : this.candle.upLight)
            : (p.hist <= prev ? this.candle.down : this.candle.downLight)
        return { time: sec(p.time), value: p.hist, color }
      }),
    )

    if (this.firstRender) {
      // 默认展示最近 240 根，太密看不清通道形态
      const total = candles.length
      this.chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, total - 240),
        to: total + 6,
      })
      this.firstRender = false
    }
  }

  /** 状态翻转处画 ▲ / ▼，并合并结构标记（setMarkers 是整体替换） */
  private applyMarkers(
    candles: Candle[],
    channel: ChannelResult,
    structures: StructurePoint[],
  ): void {
    const list: SeriesMarker<Time>[] = []

    for (let i = 0; i < channel.points.length; i++) {
      const p = channel.points[i]
      if (!p.flipped) continue

      const isUp = p.state === 1
      // 最后一根若未收盘，翻转尚未确认，用空心弱化表示
      const unconfirmed = i === channel.points.length - 1 && !candles[i].closed

      list.push({
        time: sec(p.time),
        position: isUp ? 'belowBar' : 'aboveBar',
        shape: isUp ? 'arrowUp' : 'arrowDown',
        color: unconfirmed
          ? (isUp ? 'rgba(0,230,118,0.45)' : 'rgba(242,54,69,0.45)')
          : (isUp ? COLORS.flipUp : COLORS.flipDown),
        size: 1,
        text: unconfirmed ? '待确认' : undefined,
      })
    }

    // 标记必须整体按时间升序，否则 lightweight-charts 会丢弃乱序之后的全部标记。
    // 趋势标记与结构标记各自有序，但拼接后不是——必须重排。
    const all = [...list, ...this.structureMarkers(structures)]
    all.sort((a, b) => (a.time as number) - (b.time as number))
    this.markers.setMarkers(all)
  }

  /**
   * 结构标记。
   *
   * 用 circle 与趋势翻转的 arrow 区分形状——两者是不同性质的信号：
   * 趋势是右侧跟进，结构是左侧抢转折点，混用同一形状会读错。
   * 底部结构标在 K 线下方（买点），顶部标在上方（卖点）；
   * 纠错点（钝化消失）用叉号单独标出。
   */
  private structureMarkers(structures: StructurePoint[]): SeriesMarker<Time>[] {
    const list: SeriesMarker<Time>[] = []

    for (const s of structures) {
      if (s.formedTime !== null) {
        const isBottom = s.type === 'bottom'
        list.push({
          time: sec(s.formedTime),
          position: isBottom ? 'belowBar' : 'aboveBar',
          shape: 'circle',
          color: s.pending
            ? (isBottom ? alpha(this.candle.up, 0.4) : alpha(this.candle.down, 0.4))
            : (isBottom ? this.candle.up : this.candle.down),
          size: 1,
          text: s.pending ? '结构待确认' : (isBottom ? '底结构' : '顶结构'),
        })
      }

      if (s.invalidatedTime !== null) {
        list.push({
          time: sec(s.invalidatedTime),
          position: s.type === 'bottom' ? 'belowBar' : 'aboveBar',
          shape: 'square',
          color: COLORS.text,
          size: 0,
          text: '纠错',
        })
      }
    }

    return list
  }

  /** 重置缩放，下次 setData 时重新定位到最新区间 */
  resetView(): void {
    this.firstRender = true
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    this.chart.remove()
  }
}

/** 价格格式化：大额保留两位，小额（如 SHIB）保留更多有效位 */
export function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return '—'
  const abs = Math.abs(p)
  if (abs >= 1000) return p.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  if (abs >= 1) return p.toFixed(2)
  if (abs >= 0.01) return p.toFixed(4)
  return p.toPrecision(4)
}
