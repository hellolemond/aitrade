import { fetchTickers, type Ticker } from '../lib/binance.ts'
import { shortSymbol } from '../lib/types.ts'
import { normalizeSymbol } from '../lib/watchlist.ts'
import { formatPrice } from './chart.ts'
import { esc, icon } from './dom.ts'

export interface SymbolPickerHandlers {
  onSelect(symbol: string): void
  /** 成功返回 null，失败返回给用户看的原因 */
  onAdd(symbol: string): Promise<string | null>
  onRemove(symbol: string): void
  loadCandidates(): Promise<string[]>
}

/** 跑着策略的币种不能删除 */
const LOCKED = new Set(['BTCUSDT'])

const MAX_RESULTS = 8

/**
 * 顶栏币种下拉：上面搜索（回车添加），下面是自选列表，带价格与 24h 涨跌，可删除。
 */
export class SymbolPicker {
  private readonly btn: HTMLButtonElement
  private readonly pop: HTMLElement
  private symbols: string[] = []
  private current = ''
  private tickers = new Map<string, Ticker>()
  private query = ''
  private hl = 0
  private message = ''
  private candidates: string[] | null = null

  constructor(
    root: HTMLElement,
    private readonly handlers: SymbolPickerHandlers,
  ) {
    root.classList.add('picker')
    root.innerHTML = `
      <button type="button" class="picker-btn" aria-haspopup="listbox"><span class="picker-sym"></span>${icon('down', 14)}</button>
      <button type="button" class="picker-add" title="添加币种">${icon('plus', 14)}</button>
      <div class="picker-pop" hidden>
        <label class="picker-search">${icon('search', 14)}<input placeholder="搜索币安交易对，回车添加" spellcheck="false" autocomplete="off"></label>
        <div class="picker-list" role="listbox"></div>
      </div>`
    this.btn = root.querySelector('.picker-btn')!
    this.pop = root.querySelector('.picker-pop')!
    const input = root.querySelector<HTMLInputElement>('input')!

    this.btn.addEventListener('click', () => {
      this.toggle()
      if (!this.pop.hidden) input.focus()
    })
    root.querySelector('.picker-add')!.addEventListener('click', () => {
      this.open()
      input.focus()
    })
    input.addEventListener('input', () => {
      this.query = input.value
      this.hl = 0
      this.message = ''
      this.renderList()
    })
    input.addEventListener('keydown', (e) => {
      const items = this.items()
      if (e.key === 'ArrowDown') this.hl = Math.min(this.hl + 1, items.length - 1)
      else if (e.key === 'ArrowUp') this.hl = Math.max(this.hl - 1, 0)
      else if (e.key === 'Escape') return this.close()
      else if (e.key === 'Enter') {
        const pick = items[this.hl]?.symbol ?? normalizeSymbol(this.query)
        if (pick) void this.choose(pick, input)
        return
      } else return
      e.preventDefault()
      this.renderList()
    })
    // 点列表行时不让输入框失焦；点输入框本身要放行，否则无法聚焦
    this.pop.addEventListener('mousedown', (e) => {
      if (e.target !== input) e.preventDefault()
    })
    this.pop.addEventListener('click', (e) => {
      const el = e.target as HTMLElement
      const del = el.closest<HTMLElement>('[data-del]')
      if (del) {
        this.handlers.onRemove(del.dataset.del!)
        return
      }
      const row = el.closest<HTMLElement>('[data-sym]')
      if (row) void this.choose(row.dataset.sym!, input)
    })
    document.addEventListener('mousedown', (e) => {
      if (!root.contains(e.target as Node)) this.close()
    })
  }

  setSymbols(symbols: readonly string[], current: string): void {
    this.symbols = [...symbols]
    this.current = current
    this.btn.querySelector('.picker-sym')!.textContent = current
    if (!this.pop.hidden) this.renderList()
  }

  setTickers(list: readonly Ticker[]): void {
    for (const t of list) this.tickers.set(t.symbol, t)
    if (!this.pop.hidden) this.renderList()
  }

  private toggle(): void {
    if (this.pop.hidden) this.open()
    else this.close()
  }

  private open(): void {
    this.pop.hidden = false
    this.query = ''
    this.message = ''
    this.hl = Math.max(0, this.symbols.indexOf(this.current))
    this.pop.querySelector('input')!.value = ''
    this.renderList()
    fetchTickers(this.symbols).then((t) => this.setTickers(t), () => {})
    if (!this.candidates) {
      this.handlers.loadCandidates().then((c) => {
        this.candidates = c
        if (this.query) this.renderList()
      }, () => {})
    }
  }

  private close(): void {
    this.pop.hidden = true
  }

  private async choose(symbol: string, input: HTMLInputElement): Promise<void> {
    if (this.symbols.includes(symbol)) {
      this.handlers.onSelect(symbol)
      this.close()
      return
    }
    this.message = `添加 ${shortSymbol(symbol)} 中…`
    this.renderList()
    const err = await this.handlers.onAdd(symbol)
    if (err) {
      this.message = err
      this.renderList()
      return
    }
    input.value = ''
    this.query = ''
    this.close()
  }

  /** 无搜索词时列自选；有搜索词时自选里匹配的在前，其余候选在后 */
  private items(): { symbol: string; added: boolean }[] {
    const q = this.query.trim().toUpperCase().replace(/[\s/_-]/g, '')
    if (!q) return this.symbols.map((symbol) => ({ symbol, added: true }))
    const mine = this.symbols.filter((s) => s.includes(q)).map((symbol) => ({ symbol, added: true }))
    const others = (this.candidates ?? [])
      .filter((s) => !this.symbols.includes(s) && s.includes(q))
      .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.length - b.length)
      .map((symbol) => ({ symbol, added: false }))
    return [...mine, ...others].slice(0, MAX_RESULTS)
  }

  private renderList(): void {
    const list = this.pop.querySelector<HTMLElement>('.picker-list')!
    const items = this.items()
    const rows = items.map(({ symbol, added }, i) => {
      const t = this.tickers.get(symbol)
      const right = added
        ? `${t ? `<span class="pk-price">${formatPrice(t.price)}</span><span class="pk-chg ${t.changePct >= 0 ? 'c-up' : 'c-down'}">${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%</span>` : ''}
           ${LOCKED.has(symbol)
             ? '<span class="pk-lock" title="BTC H 方案使用中，不能删除">H</span>'
             : this.symbols.length > 1 ? `<button type="button" class="pk-del" data-del="${symbol}" title="删除">${icon('x', 12)}</button>` : ''}`
        : '<span class="pk-add">回车添加</span>'
      return `<div class="pk-row ${symbol === this.current ? 'is-cur' : ''} ${i === this.hl ? 'is-hl' : ''}" data-sym="${symbol}" role="option">
        <span class="pk-sym">${esc(symbol)}</span>${right}</div>`
    })
    if (rows.length === 0) rows.push(`<div class="pk-msg">${this.candidates ? '没有匹配的交易对，回车按输入添加' : '加载交易对中…'}</div>`)
    if (this.message) rows.push(`<div class="pk-msg">${esc(this.message)}</div>`)
    list.innerHTML = rows.join('')
  }
}
