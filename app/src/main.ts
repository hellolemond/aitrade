import { KlineSocket, fetchKlines, fetchTickers, fetchUsdtSymbols, mergeBatch, mergeCandle } from './lib/binance.ts'
import { DEFAULT_SWING_WINDOW, INTERVALS, INTERVAL_LABELS, shortSymbol, type Candle, type ConnectionState, type Interval } from './lib/types.ts'
import { loadWatchlist, saveWatchlist } from './lib/watchlist.ts'
import { closeDate, fmtUsd } from './lib/hStrategy.ts'
import { HController } from './hController.ts'
import { Store, type Preferences } from './mygo.ts'
import { TrendChart, computeAll, formatPrice, type RenderPayload } from './ui/chart.ts'
import { SymbolPicker } from './ui/symbolPicker.ts'
import './style.css'

const DEFAULT_INTERVAL: Interval = '1d'

/** 顶栏 24h 涨跌幅的刷新间隔 */
const TICKER_MS = 60_000

/** 从 URL hash 解析 `#BTCUSDT/1d`，刷新后保持当前币种与周期 */
function readHash(watchlist: readonly string[]): { symbol: string; interval: Interval } {
  const [s, i] = location.hash.replace(/^#/, '').split('/')
  const upper = (s ?? '').toUpperCase()
  return {
    symbol: watchlist.includes(upper) ? upper : watchlist[0],
    interval: INTERVALS.includes(i as Interval) ? (i as Interval) : DEFAULT_INTERVAL,
  }
}

function writeHash(symbol: string, interval: Interval): void {
  const next = `#${symbol}/${interval}`
  if (location.hash !== next) history.replaceState(null, '', next)
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

/**
 * 主窗口：顶栏（币种、价格、周期、同步状态、设置）+ 左侧 K 线图 + 右侧 H 方案面板。
 * K 线图沿用 t 仓库的 TrendChart。
 */
class App {
  private readonly chart = new TrendChart($('#chart'))
  private readonly picker: SymbolPicker
  private readonly legendEl = $('#chart-legend')
  private readonly priceEl = $('#top-price')
  private readonly intervalsEl = $('#intervals')

  private symbol: string
  private interval: Interval
  private candles: Candle[] = []
  private conn: ConnectionState = 'connecting'
  private changePct: number | null = null
  private socket: KlineSocket | null = null
  private abort: AbortController | null = null
  private loadToken = 0
  private candidates: Promise<string[]> | null = null

  constructor(
    private watchlist: string[],
    private readonly h: HController,
  ) {
    const initial = readHash(watchlist)
    this.symbol = initial.symbol
    this.interval = initial.interval

    this.picker = new SymbolPicker($('#picker'), {
      onSelect: (s) => this.switchTo(s, this.interval),
      onAdd: (s) => this.addSymbol(s),
      onRemove: (s) => this.removeSymbol(s),
      loadCandidates: () => (this.candidates ??= fetchUsdtSymbols()),
    })
    this.picker.setSymbols(watchlist, this.symbol)

    for (const iv of INTERVALS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = iv
      b.title = INTERVAL_LABELS[iv]
      b.dataset.iv = iv
      b.addEventListener('click', () => this.switchTo(this.symbol, iv))
      this.intervalsEl.appendChild(b)
    }

    window.addEventListener('hashchange', () => {
      const { symbol, interval } = readHash(this.watchlist)
      this.switchTo(symbol, interval)
    })
    setInterval(() => void this.refreshTicker(), TICKER_MS)

    this.syncControls()
    void this.load()
    void this.refreshTicker()
  }

  private syncControls(): void {
    this.picker.setSymbols(this.watchlist, this.symbol)
    for (const b of this.intervalsEl.querySelectorAll<HTMLElement>('button')) {
      b.classList.toggle('is-active', b.dataset.iv === this.interval)
    }
    this.chart.setLabel(this.symbol, this.interval)
    document.title = `${this.symbol} · AiTrade`
  }

  private switchTo(symbol: string, interval: Interval): void {
    if (symbol === this.symbol && interval === this.interval) return
    const symbolChanged = symbol !== this.symbol
    this.symbol = symbol
    this.interval = interval
    writeHash(symbol, interval)
    this.chart.resetView()
    this.syncControls()
    if (symbolChanged) {
      this.changePct = null
      void this.refreshTicker()
    }
    void this.load()
  }

  /** 先确认交易对存在再写进列表，避免留下永远加载中的空壳 */
  private async addSymbol(symbol: string): Promise<string | null> {
    if (this.watchlist.includes(symbol)) {
      this.switchTo(symbol, this.interval)
      return null
    }
    try {
      await fetchKlines(symbol, this.interval, 1)
    } catch {
      return `币安现货没有 ${shortSymbol(symbol)}/USDT 交易对`
    }
    this.watchlist = [...this.watchlist, symbol]
    saveWatchlist(this.watchlist)
    this.switchTo(symbol, this.interval)
    this.syncControls()
    return null
  }

  private removeSymbol(symbol: string): void {
    if (this.watchlist.length <= 1 || symbol === 'BTCUSDT') return
    this.watchlist = this.watchlist.filter((s) => s !== symbol)
    saveWatchlist(this.watchlist)
    if (symbol === this.symbol) this.switchTo(this.watchlist[0], this.interval)
    this.syncControls()
  }

  private async refreshTicker(): Promise<void> {
    try {
      const [t] = await fetchTickers([this.symbol])
      if (t && t.symbol === this.symbol) {
        this.changePct = t.changePct
        this.renderPrice()
      }
    } catch {
      // 涨跌幅只是辅助信息，失败时保留上次的值
    }
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken
    this.socket?.close()
    this.socket = null
    this.abort?.abort()
    this.abort = new AbortController()
    writeHash(this.symbol, this.interval)
    this.setConnection('connecting')

    try {
      const candles = await fetchKlines(this.symbol, this.interval, 1000, this.abort.signal)
      if (token !== this.loadToken) return
      this.candles = candles
      this.render()
      this.openSocket(token)
    } catch (err) {
      if (token !== this.loadToken) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      this.setConnection('closed')
    }
  }

  private openSocket(token: number): void {
    const socket = new KlineSocket(this.symbol, this.interval, {
      onCandle: (candle) => {
        if (token !== this.loadToken) return
        this.candles = mergeCandle(this.candles, candle)
        if (this.symbol === 'BTCUSDT') this.h.setLivePrice(candle.close)
        this.render()
      },
      onStatus: (status) => {
        if (token === this.loadToken) this.setConnection(status)
      },
      onResync: (batch) => {
        if (token !== this.loadToken) return
        // 补缺口后整体重算——趋势状态递归，缺一根后面全错
        this.candles = mergeBatch(this.candles, batch)
        this.render()
      },
    })
    this.socket = socket
    socket.connect()
  }

  private setConnection(status: ConnectionState): void {
    this.conn = status
    if (this.candles.length) this.renderLegend(computeAll(this.candles, DEFAULT_SWING_WINDOW))
  }

  private render(): void {
    const payload = computeAll(this.candles, DEFAULT_SWING_WINDOW)
    this.chart.setData(payload)
    this.renderLegend(payload)
    this.renderPrice()
  }

  private renderPrice(): void {
    const last = this.candles[this.candles.length - 1]
    const up = (this.changePct ?? 0) >= 0
    this.priceEl.className = `top-price ${this.changePct === null ? '' : up ? 'c-up' : 'c-down'}`
    this.priceEl.innerHTML = `<b>${last ? formatPrice(last.close) : '—'}</b><span>${this.changePct === null ? '' : `${up ? '+' : ''}${this.changePct.toFixed(2)}%`}</span>`
  }

  private renderLegend({ channel }: RenderPayload): void {
    const p = channel.points[channel.points.length - 1]
    // 图表跟 TradingView 一样，最后一根未收盘 K 线也参与计算，轨道值会随价格跳动
    const live = this.candles.length > 0 && !this.candles[this.candles.length - 1].closed
    if (!p) return
    const bull = channel.state === 1
    const flipText = channel.lastFlipTime === null
      ? ''
      : ` · ${this.interval === '1d' ? closeDate(channel.lastFlipTime) : new Date(channel.lastFlipTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} ${bull ? '转多' : '转空'}`
    const conn: Record<ConnectionState, [string, string]> = {
      connecting: ['is-connecting', '连接中'],
      open: ['is-open', '实时'],
      reconnecting: ['is-reconnecting', '重连中'],
      closed: ['is-closed', '已断开'],
    }
    const [cls, label] = conn[this.conn]
    const fmt = (x: number) => (x >= 1000 ? fmtUsd(x, 0) : formatPrice(x))
    this.legendEl.innerHTML = `
      <span class="lg-title">${this.symbol} · ${this.interval.toUpperCase()} · 趋势通道</span>
      <span class="lg-line" title="${live ? '含当前未收盘 K 线，随价格变动；收盘后才作为信号依据' : '最新已收盘 K 线'}"><i class="is-up"></i>上轨 ${fmt(p.upper)}</span>
      <span class="lg-line"><i class="is-down"></i>下轨 ${fmt(p.lower)}</span>
      ${live ? '<span class="lg-live">实时 · 未收盘</span>' : ''}
      <span class="tag ${bull ? 'is-bull' : 'is-bear'}">${bull ? '多头' : '空头'}${channel.pending ? '（未收盘）' : ''}${flipText}</span>
      <span class="grow"></span>
      <span class="lg-conn ${cls}"><i></i>${label}</span>`
  }

  setCandleColors(up: string, down: string): void {
    this.chart.setCandleColors(up, down)
  }

  destroy(): void {
    this.socket?.close()
    this.abort?.abort()
    this.chart.destroy()
  }
}

const h = new HController($('#hpanel'), $('#todo-badge'))
$('#open-settings').addEventListener('click', () => h.openSettings())
$('#toggle-panel').addEventListener('click', () => h.toggleCollapsed())
$('#todo-chip').addEventListener('click', () => h.setCollapsed(false))
const app = new App(await loadWatchlist(), h)

/** 应用 K 线涨跌色：图表重绘；顶栏涨跌幅、下拉涨跌、盈亏用 CSS 变量跟随 */
function applyPrefs(p: Preferences): void {
  document.documentElement.style.setProperty('--up', p.upColor)
  document.documentElement.style.setProperty('--down', p.downColor)
  app.setCandleColors(p.upColor, p.downColor)
}
h.onPrefs = applyPrefs
Store.preferences().then(applyPrefs, (err) => console.error('读取设置失败', err))
window.addEventListener('beforeunload', () => app.destroy())
void h.start()
