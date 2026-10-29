import type { Snapshot, Task } from '../mygo.ts'
import {
  closeDate,
  fmtBtc,
  fmtUsd,
  holdingsValue,
  reconcile,
  type Account,
  type DailySignal,
  type PlanStep,
} from '../lib/hStrategy.ts'
import { esc, fmtTime, icon } from './dom.ts'

export interface HPanelModel {
  signal: DailySignal | null
  signalError: string | null
  /** 实时价格（未收盘 K 线），用于持仓估值 */
  price: number | null
  keyConfigured: boolean
  snapshot: Snapshot | null
  snapshotError: string | null
  syncing: boolean
  pending: Task[]
  totalTasks: number
}

export interface HPanelHandlers {
  onMarkStep(stepId: number, done: boolean): void
  onMarkTask(taskId: number): void
  onRefresh(): void
  onOpenRecords(): void
  onOpenSettings(): void
  onCollapse(): void
}

/** 持仓同步状态点：绿 = 已同步，黄 = 同步中，红 = 失败 */
function syncClass(m: HPanelModel): string {
  if (m.syncing) return 'is-connecting'
  if (m.snapshotError) return 'is-closed'
  return m.snapshot ? 'is-open' : ''
}

const KIND_CLASS: Record<string, string> = { flip: '', rebalance: 'is-warn' }

/**
 * 右侧 BTC H 方案面板：信号、待执行操作、实际持仓。
 * 只负责渲染，所有状态由 HController 提供。
 */
export class HPanel {
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: HPanelHandlers,
  ) {
    root.addEventListener('click', (e) => this.onClick(e))
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!el) return
    const id = Number(el.dataset.id)
    switch (el.dataset.act) {
      case 'step':
        this.handlers.onMarkStep(id, el.dataset.done !== '1')
        break
      case 'task':
        this.handlers.onMarkTask(id)
        break
      case 'refresh':
        this.handlers.onRefresh()
        break
      case 'records':
        this.handlers.onOpenRecords()
        break
      case 'settings':
        this.handlers.onOpenSettings()
        break
      case 'collapse':
        this.handlers.onCollapse()
        break
    }
  }

  render(m: HPanelModel): void {
    this.root.innerHTML = `${this.signalSection(m)}${this.taskSection(m)}${this.holdingsSection(m)}`
  }

  private signalSection(m: HPanelModel): string {
    const s = m.signal
    if (!s) {
      return `<section class="hp-sec">
        <div class="hp-head"><span class="hp-title">BTC H 方案 · 日线</span>
          <button type="button" class="hp-collapse" data-act="collapse" title="收起侧栏">${icon('chevron', 14)}</button></div>
        <div class="hp-empty ${m.signalError ? 'is-error' : ''}">${esc(m.signalError ?? '加载日线中…')}</div>
      </section>`
    }
    const bull = s.state === 1
    const since = s.flipTime === null
      ? '无翻转记录'
      : s.barsSinceFlip === 0
        ? `今天 08:00 收盘${bull ? '转多' : '转空'}`
        : `${closeDate(s.flipTime)} ${bull ? '转多' : '转空'}，持续 ${s.barsSinceFlip} 天`
    const dist = bull
      ? `收盘 < ${fmtUsd(s.lower, 0)}（${((s.lower / s.close - 1) * 100).toFixed(1)}%）`
      : `收盘 > ${fmtUsd(s.upper, 0)}（+${((s.upper / s.close - 1) * 100).toFixed(1)}%）`
    return `<section class="hp-sec">
      <div class="hp-head">
        <span class="hp-title">BTC H 方案 · 日线</span>
        <span class="hp-meta">${closeDate(s.candleTime)} 08:00 收盘
          <button type="button" class="hp-collapse" data-act="collapse" title="收起侧栏">${icon('chevron', 14)}</button></span>
      </div>
      <div class="hp-state">
        <span class="hp-pill ${bull ? 'is-bull' : 'is-bear'}">${bull ? '多头' : '空头'}</span>
        <span class="hp-since">${esc(since)}</span>
      </div>
      <dl class="hp-kv">
        <dt>收盘价</dt><dd>${fmtUsd(s.close, 1)}</dd>
        <dt title="按已收盘日线计算，作为信号依据；图表上方的数值含未收盘 K 线">上轨 / 下轨（已收盘）</dt><dd>${fmtUsd(s.upper, 0)} / ${fmtUsd(s.lower, 0)}</dd>
        <dt>距离${bull ? '转空' : '转多'}</dt><dd class="${bull ? 'c-bear' : 'c-bull'}">${dist}</dd>
      </dl>
    </section>`
  }

  /** 没有待执行操作时整块不显示，「操作记录」入口也一起隐藏 */
  private taskSection(m: HPanelModel): string {
    const records = `<button type="button" class="hp-link" data-act="records">${icon('history', 12)}操作记录（${m.totalTasks}）</button>`
    if (m.pending.length === 0) return ''
    const foot = `<div class="hp-foot">
      ${records}
      <button type="button" class="btn btn-dark" data-act="task" data-id="${m.pending[0].id}">全部标记为已操作</button>
    </div>`
    const totalSteps = m.pending.reduce((n, t) => n + t.steps.length, 0)
    const doneSteps = m.pending.reduce((n, t) => n + t.steps.filter((s) => s.doneAt).length, 0)
    const blocks = m.pending.map((t) => `
      <div class="hp-task">
        <div class="hp-task-head">
          <span class="tag ${KIND_CLASS[t.kind] ?? ''} ${t.title === '转多' ? 'is-bull' : t.title === '转空' ? 'is-bear' : ''}">${esc(t.title)}</span>
          <span class="hp-meta">${closeDate(t.candleTime)} · 收盘 ${fmtUsd(t.close, 0)}</span>
          ${m.pending.length > 1 ? `<button type="button" class="hp-link" data-act="task" data-id="${t.id}">本条全部完成</button>` : ''}
        </div>
        ${t.note ? `<div class="hp-note">${esc(t.note)}</div>` : ''}
        ${t.steps.map((s, i) => `
          <div class="hp-step ${s.doneAt ? 'is-done' : ''}">
            <button type="button" class="hp-check" data-act="step" data-id="${s.id}" data-done="${s.doneAt ? 1 : 0}"
              aria-label="${s.doneAt ? '撤销' : '标记已操作'}">${s.doneAt ? icon('check', 12) : ''}</button>
            <div class="hp-step-body">
              <div class="hp-step-main"><span class="acct">${esc(s.account)}</span><span class="hp-step-text">${i + 1}. ${esc(s.text)}</span></div>
              ${s.detail ? `<div class="hp-step-detail">${esc(s.detail)}</div>` : ''}
            </div>
            ${s.doneAt
              ? `<span class="hp-step-time">${fmtTime(s.doneAt).slice(6)}</span>`
              : `<button type="button" class="btn btn-line" data-act="step" data-id="${s.id}" data-done="0">标记已操作</button>`}
          </div>`).join('')}
      </div>`).join('')
    return `<section class="hp-sec hp-tasks">
      <div class="hp-head">
        <span class="hp-title">待执行操作 <span class="badge">${doneSteps}/${totalSteps}</span></span>
        <span class="hp-meta">在手机币安 App 上操作</span>
      </div>
      ${blocks}
      ${foot}
    </section>`
  }

  private holdingsSection(m: HPanelModel): string {
    const head = `<div class="hp-head">
      <span class="hp-title">实际持仓 · 只读同步</span>
      ${m.keyConfigured ? `<button type="button" class="hp-link sync ${syncClass(m)} ${m.syncing ? 'is-spin' : ''}" data-act="refresh"
        title="点击刷新持仓"><i></i>${m.syncing ? '同步中' : m.snapshotError ? '同步失败' : m.snapshot ? fmtTime(m.snapshot.time).slice(6) : '刷新'}${icon('refresh', 12)}</button>` : ''}
    </div>`
    if (!m.keyConfigured) {
      return `<section class="hp-sec">${head}
        <div class="hp-empty">未设置币安 API Key，无法核对持仓。<br>只需要「允许读取」权限。</div>
        <button type="button" class="btn btn-line hp-wide" data-act="settings">${icon('settings', 12)}设置 API Key</button>
      </section>`
    }
    const h = m.snapshot
    if (!h) {
      return `<section class="hp-sec">${head}
        <div class="hp-empty ${m.snapshotError ? 'is-error' : ''}">${esc(m.snapshotError ?? '读取持仓中…')}</div>
      </section>`
    }
    const s = m.signal
    const price = m.price ?? s?.close ?? 0
    const gaps = s ? reconcile(s.state, h, price) : []
    const by = (accts: Account[]) => gaps.filter((g) => accts.includes(g.account))
    const card = (name: string, rows: [string, string, string?][], diff: PlanStep[]) => `
      <div class="hp-card">
        <div class="hp-card-head">
          <span>${name}</span>
          ${s && diff.length
            ? `<span class="c-warn">${icon('alert', 12)}${esc(diff[0].text)}${diff.length > 1 ? ` 等 ${diff.length} 项` : ''}</span>`
            : ''}
        </div>
        <dl class="hp-kv">${rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c ?? ''}">${v}</dd>`).join('')}</dl>
      </div>`
    const pnl = (x: number, d: number, unit: string) =>
      [`${x > 0 ? '+' : ''}${x.toFixed(d)} ${unit}`, x > 0 ? 'c-up' : x < 0 ? 'c-down' : ''] as const
    const cm = h.coinM
    const um = h.usdM
    const v = s ? holdingsValue(h, price, s.state) : null
    const warnings = [...h.warnings]
    // 平时比例随盈亏漂移、每年再平衡一次；偏离超过 25 个百分点多半是资金没按 70:30 放好
    if (v && v.total > 0 && Math.abs(v.mainRatio - 0.7) > 0.25) {
      warnings.push(`主仓 : 空单仓 = ${(v.mainRatio * 100).toFixed(0)} : ${(100 - v.mainRatio * 100).toFixed(0)}，目标 70 : 30。主仓 USDT 应放在现货账户（资金账户里的读不到）`)
    }
    const umPnl = pnl(um.unrealizedUsdt, 2, 'USDT')
    const cmPnl = pnl(cm.unrealizedBtc, 6, 'BTC')
    return `<section class="hp-sec">${head}
      ${m.snapshotError ? `<div class="hp-empty is-error">${esc(m.snapshotError)}</div>` : ''}
      ${card('现货 · 主仓', [['USDT', fmtUsd(h.spot.usdt)], ['BTC', fmtBtc(h.spot.btc) || '0']], by(['现货', '划转']))}
      ${card('币本位 · 主仓对冲', [
        ['BTC 余额', fmtBtc(cm.walletBtc) || '0'],
        ['BTCUSD 空单', cm.contracts ? `${cm.contracts} 张 @ ${fmtUsd(cm.entry, 1)}` : '—'],
        ...(cm.contracts ? [['未实现盈亏', cmPnl[0], cmPnl[1]] as [string, string, string]] : []),
      ], by(['币本位']))}
      ${card('U 本位 · 空单仓', [
        ['钱包余额', `${fmtUsd(um.walletUsdt)} USDT`],
        ['BTCUSDT 空单', um.shortQty ? `${fmtBtc(um.shortQty)} @ ${fmtUsd(um.entry, 1)}` : '—'],
        ...(um.shortQty ? [
          ['未实现盈亏', umPnl[0], umPnl[1]] as [string, string, string],
          ['强平价', um.liqPrice ? `${fmtUsd(um.liqPrice, 0)}（${(um.liqPrice / um.entry).toFixed(2)}×）` : '—'] as [string, string],
        ] : []),
      ], by(['U本位']))}
      ${warnings.length ? `<ul class="hp-warn">${warnings.map((w) => `<li>${icon('alert', 12)}${esc(w)}</li>`).join('')}</ul>` : ''}
      ${v ? `<div class="hp-total">
        <span>总权益 · 主仓 ${(v.mainRatio * 100).toFixed(0)}% : 空单仓 ${(100 - v.mainRatio * 100).toFixed(0)}%</span>
        <b>${fmtUsd(v.total)}</b>
      </div>` : ''}
    </section>`
  }
}
