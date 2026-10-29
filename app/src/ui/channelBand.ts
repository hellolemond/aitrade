import type {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  Time,
} from 'lightweight-charts'
import { customSeriesDefaultOptions } from 'lightweight-charts'

/** 通道填充的单点数据：上下轨 + 当根的多空状态 */
export interface ChannelBandData extends CustomData<Time> {
  time: Time
  upper: number
  lower: number
  /** 1 = 多头，0 = 空头。决定填充色 */
  state: 0 | 1
}

export interface ChannelBandOptions extends CustomSeriesOptions {
  bullColor: string
  bearColor: string
}

const defaults: ChannelBandOptions = {
  ...customSeriesDefaultOptions,
  bullColor: 'rgba(239, 83, 80, 0.14)',
  bearColor: 'rgba(38, 166, 154, 0.14)',
} as ChannelBandOptions

/**
 * 通道填充渲染器。
 *
 * lightweight-charts 没有内置的「两线之间填充」，因此自绘：
 * 把连续同状态的 K 线聚成一段，每段画一个由上轨和下轨围成的闭合多边形。
 * 按状态分段是必要的——多空切换处颜色必须硬切，不能渐变。
 */
class ChannelBandRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, ChannelBandData> | null = null
  private options: ChannelBandOptions | null = null

  update(
    data: PaneRendererCustomData<Time, ChannelBandData>,
    options: ChannelBandOptions,
  ): void {
    this.data = data
    this.options = options
  }

  draw(target: CanvasRenderingTarget2D, priceToCoordinate: PriceToCoordinateConverter): void {
    const data = this.data
    const options = this.options
    if (!data || !options || data.bars.length === 0 || data.visibleRange === null) return

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const { horizontalPixelRatio: hRatio, verticalPixelRatio: vRatio } = scope
      const { from, to } = data.visibleRange!

      // 向两侧各多取一根，避免边缘出现填充断口
      const start = Math.max(0, from - 1)
      const end = Math.min(data.bars.length, to + 1)

      let segStart = start
      while (segStart < end) {
        const state = data.bars[segStart].originalData.state
        // 找出同状态的连续区段
        let segEnd = segStart + 1
        while (segEnd < end && data.bars[segEnd].originalData.state === state) segEnd++

        // 与下一段共享一根，让颜色在切换点严丝合缝
        const drawEnd = Math.min(segEnd + 1, end)
        this.fillSegment(ctx, data, priceToCoordinate, hRatio, vRatio, segStart, drawEnd, state, options)

        segStart = segEnd
      }
    })
  }

  private fillSegment(
    ctx: CanvasRenderingContext2D,
    data: PaneRendererCustomData<Time, ChannelBandData>,
    priceToCoordinate: PriceToCoordinateConverter,
    hRatio: number,
    vRatio: number,
    from: number,
    to: number,
    state: 0 | 1,
    options: ChannelBandOptions,
  ): void {
    if (to - from < 2) return

    ctx.beginPath()

    // 沿上轨从左向右
    for (let i = from; i < to; i++) {
      const bar = data.bars[i]
      const y = priceToCoordinate(bar.originalData.upper)
      if (y === null) continue
      const x = bar.x * hRatio
      const py = y * vRatio
      if (i === from) ctx.moveTo(x, py)
      else ctx.lineTo(x, py)
    }

    // 沿下轨从右向左折回，闭合成带状
    for (let i = to - 1; i >= from; i--) {
      const bar = data.bars[i]
      const y = priceToCoordinate(bar.originalData.lower)
      if (y === null) continue
      ctx.lineTo(bar.x * hRatio, y * vRatio)
    }

    ctx.closePath()
    ctx.fillStyle = state === 1 ? options.bullColor : options.bearColor
    ctx.fill()
  }
}

/**
 * 趋势通道填充的自定义 series。
 *
 * 只负责上下轨之间那层半透明底色；两条轨道线本身由普通 LineSeries 绘制，
 * 这样轨道线的样式、图例、价格标签都能沿用库的内置能力。
 */
export class ChannelBandSeries
  implements ICustomSeriesPaneView<Time, ChannelBandData, ChannelBandOptions>
{
  private readonly _renderer = new ChannelBandRenderer()

  priceValueBuilder(plotRow: ChannelBandData): CustomSeriesPricePlotValues {
    // 上下轨都要纳入自动缩放范围
    return [plotRow.lower, plotRow.upper]
  }

  isWhitespace(data: ChannelBandData | { time: Time }): data is { time: Time } {
    return (data as ChannelBandData).upper === undefined
  }

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer
  }

  update(
    data: PaneRendererCustomData<Time, ChannelBandData>,
    options: ChannelBandOptions,
  ): void {
    this._renderer.update(data, options)
  }

  defaultOptions(): ChannelBandOptions {
    return defaults
  }
}

/** 从 lightweight-charts 的 fancy-canvas 依赖中取的绘制目标类型 */
interface CanvasRenderingTarget2D {
  useBitmapCoordinateSpace(
    fn: (scope: {
      context: CanvasRenderingContext2D
      horizontalPixelRatio: number
      verticalPixelRatio: number
      bitmapSize: { width: number; height: number }
    }) => void,
  ): void
}
