import { Settings, Store, type Permissions, type Preferences, type Task } from '../mygo.ts'
import { closeDate, fmtUsd } from '../lib/hStrategy.ts'
import { errText, esc, fmtTime, icon } from './dom.ts'

/** 打开一个模态框，返回内容容器与关闭函数。点遮罩、按 Esc 关闭 */
function modal(title: string, width: number, onClose?: () => void) {
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="width:${width}px">
    <div class="modal-head"><span class="modal-title">${esc(title)}</span><div class="modal-tools"></div>
      <button type="button" class="modal-x" aria-label="关闭">${icon('x', 16)}</button></div>
    <div class="modal-body"></div>
  </div>`
  const close = () => {
    back.remove()
    document.removeEventListener('keydown', onKey)
    onClose?.()
  }
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
  back.addEventListener('mousedown', (e) => e.target === back && close())
  back.querySelector('.modal-x')!.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.appendChild(back)
  return {
    body: back.querySelector<HTMLElement>('.modal-body')!,
    tools: back.querySelector<HTMLElement>('.modal-tools')!,
    close,
  }
}

const PERM_ROWS: [keyof Permissions, string, boolean][] = [
  ['reading', '读取', true],
  ['spotTrading', '现货 / 杠杆交易', false],
  ['futures', '合约交易', false],
  ['withdrawals', '提现', false],
  ['transfer', '划转', false],
  ['margin', '杠杆借贷 / 统一账户交易', false],
  ['options', '期权', false],
]

function permList(p: Permissions): string {
  const rows = PERM_ROWS.map(([k, label, want]) => {
    const on = p[k] as boolean
    const ok = on === want
    return `<li class="${ok ? '' : 'is-bad'}">${icon(ok ? 'ok' : 'alert', 13)}<span>${label}</span><em>${on ? '已开启' : '未开启'}</em></li>`
  })
  rows.push(`<li class="${p.ipRestrict ? '' : 'is-tip'}">${icon(p.ipRestrict ? 'ok' : 'alert', 13)}<span>IP 白名单</span><em>${p.ipRestrict ? '已绑定' : '未绑定（建议绑定）'}</em></li>`)
  return `<div class="perm"><div class="perm-title">权限检查结果</div><ul>${rows.join('')}</ul></div>`
}

/** 币安 API：只读 Key。保存前检查权限，非只读一律拒绝 */
async function apiPane(root: HTMLElement, onChanged: () => void, close: () => void): Promise<void> {
  const status = await Settings.status().catch(() => ({ configured: false, apiKey: '' }))
  root.innerHTML = `
    <div class="tip">${icon('shield', 16)}<span>只需要「允许读取」权限。保存时会检查 Key 权限，开启了交易、提现或划转的 Key 会被拒绝。Key 保存在系统钥匙串，不写入本地数据库，程序只发只读请求。</span></div>
    <label class="field"><span>API Key</span><input name="key" autocomplete="off" spellcheck="false" placeholder="${status.configured ? esc(status.apiKey) + '（已保存，重新填写可替换）' : '粘贴 API Key'}"></label>
    <label class="field"><span>Secret Key</span><span class="input-wrap"><input name="secret" type="password" autocomplete="off" spellcheck="false" placeholder="${status.configured ? '••••••••（已保存）' : '粘贴 Secret Key'}"><button type="button" class="eye" aria-label="显示">${icon('eye', 14)}</button></span></label>
    <div class="result"></div>
    <div class="modal-foot">
      ${status.configured ? '<button type="button" class="btn btn-danger" data-act="delete">删除 Key</button>' : ''}
      <span class="grow"></span>
      ${status.configured ? '<button type="button" class="btn btn-line" data-act="check">检查权限</button>' : ''}
      <button type="button" class="btn btn-dark" data-act="save">保存</button>
    </div>`
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  const result = $('.result')
  const busy = (on: boolean) => root.querySelectorAll('button').forEach((b) => (b.disabled = on))
  const show = (html: string) => (result.innerHTML = html)
  const msg = (text: string, bad: boolean) => `<div class="msg ${bad ? 'is-bad' : 'is-ok'}">${icon(bad ? 'alert' : 'ok', 13)}${esc(text)}</div>`

  $('.eye').addEventListener('click', () => {
    const i = $<HTMLInputElement>('input[name=secret]')
    i.type = i.type === 'password' ? 'text' : 'password'
  })
  root.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
    if (!act) return
    busy(true)
    try {
      if (act === 'save') {
        show('<div class="msg">检查权限中…</div>')
        const r = await Settings.save($<HTMLInputElement>('input[name=key]').value, $<HTMLInputElement>('input[name=secret]').value)
        show(msg(r.message, !r.saved) + permList(r.permissions))
        if (r.saved) {
          onChanged()
          setTimeout(close, 900)
        }
      } else if (act === 'check') {
        show('<div class="msg">检查权限中…</div>')
        const p = await Settings.check()
        show(msg(p.readOnly ? '当前 Key 为只读' : '当前 Key 权限过大，请到币安改成只读', !p.readOnly) + permList(p))
      } else if (act === 'delete') {
        if (!confirm('确定从钥匙串删除币安 API Key？')) return
        await Settings.delete()
        onChanged()
        close()
      }
    } catch (err) {
      show(msg(errText(err), true))
    } finally {
      busy(false)
    }
  })
}


/** K 线颜色预设：默认红涨绿跌；另给国际习惯的绿涨红跌 */
const PRESETS: { name: string; up: string; down: string }[] = [
  { name: '红涨绿跌（默认）', up: '#ef5350', down: '#26a69a' },
  { name: '绿涨红跌', up: '#26a69a', down: '#ef5350' },
]

const COLOR_ROWS = [
  ['upColor', '上涨'],
  ['downColor', '下跌'],
] as const

/** 基础设置：K 线涨跌颜色，改动立即预览并保存 */
async function basicPane(root: HTMLElement, onPrefs: (p: Preferences) => void): Promise<void> {
  let p: Preferences = await Store.preferences().catch(() => ({ upColor: PRESETS[0].up, downColor: PRESETS[0].down }))
  let timer = 0
  const candle = (c: string, rise: boolean) =>
    `<svg width="10" height="22" viewBox="0 0 10 22" aria-hidden="true"><rect x="4.5" y="0" width="1" height="22" fill="${c}"/><rect x="0" y="${rise ? 5 : 4}" width="10" height="${rise ? 12 : 13}" fill="${c}"/></svg>`
  const render = () => {
    root.innerHTML = `
      <div class="set-group">
        <div class="set-title">K 线颜色</div>
        <div class="set-desc">K 线、MACD 柱、价格涨跌幅与盈亏使用这组颜色。趋势通道固定为多头红、空头绿。</div>
        ${COLOR_ROWS.map(([k, label]) => `
          <div class="set-row">
            <span class="set-label">${label}</span>
            <label class="swatch-pick" style="--c:${p[k]}"><input type="color" data-k="${k}" value="${p[k]}"></label>
            <input class="hex" data-hex="${k}" value="${p[k]}" maxlength="7" spellcheck="false">
          </div>`).join('')}
        <div class="set-row">
          <span class="set-label">预览</span>
          <span class="candle-preview">${[1, 1, 0, 1, 0, 0, 1].map((r) => candle(r ? p.upColor : p.downColor, !!r)).join('')}</span>
          <span class="c-up">+1.24%</span><span class="c-down">−0.86%</span>
        </div>
        <div class="set-row">
          <span class="set-label">预设</span>
          <div class="presets">${PRESETS.map((x, i) => `
            <button type="button" class="preset ${x.up === p.upColor && x.down === p.downColor ? 'is-active' : ''}" data-preset="${i}">
              <i style="background:${x.up}"></i><i style="background:${x.down}"></i>${x.name}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="result"></div>`
  }
  const update = (next: Preferences, rerender = true) => {
    p = next
    onPrefs(p)
    if (rerender) render()
    clearTimeout(timer)
    // 拖动取色器时会连续触发，停下来再写库
    timer = window.setTimeout(() => {
      Store.savePreferences(p).catch((err) => {
        root.querySelector('.result')!.innerHTML = `<div class="msg is-bad">${icon('alert', 13)}${esc(errText(err))}</div>`
      })
    }, 300)
  }
  render()
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.k) {
      update({ ...p, [el.dataset.k]: el.value }, false)
      el.closest('.set-row')!.querySelector<HTMLInputElement>('.hex')!.value = el.value
      ;(el.parentElement as HTMLElement).style.setProperty('--c', el.value)
    } else if (el.dataset.hex && /^#[0-9a-fA-F]{6}$/.test(el.value)) {
      update({ ...p, [el.dataset.hex]: el.value.toLowerCase() })
    }
  })
  // 取色器关闭后再整体重绘（预览、预设高亮）；拖动中重绘会打断取色
  root.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).dataset.k) render()
  })
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-preset]')
    if (!b) return
    const x = PRESETS[Number(b.dataset.preset)]
    update({ upColor: x.up, downColor: x.down })
  })
}

export type SettingsTab = 'basic' | 'api'

export interface SettingsOptions {
  tab?: SettingsTab
  onKeyChanged(): void
  onPrefs(p: Preferences): void
}

/** 设置：左侧分类（基础设置、币安 API），右侧内容 */
export function openSettings(opts: SettingsOptions): void {
  const m = modal('设置', 640)
  m.body.classList.add('set-body')
  m.body.innerHTML = `
    <nav class="set-nav">
      <button type="button" data-tab="basic">${icon('palette', 14)}基础设置</button>
      <button type="button" data-tab="api">${icon('key', 14)}币安 API</button>
    </nav>
    <div class="set-pane"></div>`
  let pane = m.body.querySelector<HTMLElement>('.set-pane')!
  const show = (tab: SettingsTab) => {
    m.body.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab))
    // 换一个新容器，避免上一个面板的事件监听残留
    const fresh = pane.cloneNode(false) as HTMLElement
    pane.replaceWith(fresh)
    pane = fresh
    if (tab === 'basic') void basicPane(fresh, opts.onPrefs)
    else void apiPane(fresh, opts.onKeyChanged, m.close)
  }
  m.body.querySelector('.set-nav')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')
    if (b) show(b.dataset.tab as SettingsTab)
  })
  show(opts.tab ?? 'basic')
}

const STATUS_LABEL: Record<string, [string, string]> = {
  pending: ['未完成', 'c-warn'],
  done: ['已完成', 'c-ok'],
  superseded: ['已被新信号取代', 'c-faint'],
}

function tagClass(t: Task): string {
  if (t.title === '转多') return 'is-bull'
  if (t.title === '转空') return 'is-bear'
  return t.kind === 'rebalance' ? 'is-warn' : 'is-neutral'
}

/** 操作记录：按状态筛选，点开看每一步与标记时间 */
export function openRecords(onChanged: () => void): void {
  const m = modal('操作记录', 680)
  let filter = ''
  const open = new Set<number>()
  m.tools.innerHTML = `<div class="seg">${[['', '全部'], ['pending', '未完成'], ['done', '已完成']]
    .map(([k, l]) => `<button type="button" data-f="${k}" class="${k === filter ? 'is-active' : ''}">${l}</button>`).join('')}</div>`
  m.tools.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')
    if (!b) return
    filter = b.dataset.f!
    m.tools.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('is-active', x === b))
    void load()
  })

  const render = (tasks: Task[]) => {
    if (tasks.length === 0) {
      m.body.innerHTML = '<div class="rec-empty">没有记录</div>'
      return
    }
    m.body.innerHTML = `<div class="rec-list">${tasks.map((t) => {
      const [label, cls] = STATUS_LABEL[t.status] ?? [t.status, '']
      const done = t.steps.filter((s) => s.doneAt).length
      const isOpen = open.has(t.id)
      return `<div class="rec ${isOpen ? 'is-open' : ''}">
        <button type="button" class="rec-row" data-toggle="${t.id}">
          <span class="rec-chev">${icon('chevron', 12)}</span>
          <span class="tag ${tagClass(t)}">${esc(t.title)}</span>
          <span class="rec-meta">${closeDate(t.candleTime, true)} · 收盘 ${fmtUsd(t.close, 0)}</span>
          <span class="grow"></span>
          <span class="rec-status ${cls}">${label}${t.status === 'pending' ? ` ${done}/${t.steps.length}` : t.doneAt ? ` · ${fmtTime(t.doneAt)}` : ''}</span>
        </button>
        ${isOpen ? `<div class="rec-steps">
          ${t.note ? `<div class="rec-note">${esc(t.note)}</div>` : ''}
          ${t.steps.length === 0 ? '<div class="rec-note">持仓已符合目标，无需操作</div>' : ''}
          ${t.steps.map((s) => `<div class="rec-step ${s.doneAt ? 'is-done' : ''}">
            ${icon(s.doneAt ? 'ok' : 'alert', 13)}<span class="acct">${esc(s.account)}</span>
            <span class="rec-text">${esc(s.text)}${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</span>
            ${t.status === 'superseded'
              ? `<em>${s.doneAt ? fmtTime(s.doneAt) : '未操作'}</em>`
              : `<button type="button" class="rec-mark" data-step="${s.id}" data-done="${s.doneAt ? 1 : 0}">${s.doneAt ? `${fmtTime(s.doneAt)} · 撤销` : '标记已操作'}</button>`}
          </div>`).join('')}
        </div>` : ''}
      </div>`
    }).join('')}</div>
    <div class="rec-foot">记录由日线收盘信号自动生成，数量按生成时的实际持仓计算 · 共 ${tasks.length} 条</div>`
  }

  m.body.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement
    const tg = el.closest<HTMLElement>('[data-toggle]')
    if (tg) {
      const id = Number(tg.dataset.toggle)
      if (open.has(id)) open.delete(id)
      else open.add(id)
      void load()
      return
    }
    const st = el.closest<HTMLElement>('[data-step]')
    if (st) {
      await Store.markStep(Number(st.dataset.step), st.dataset.done !== '1')
      onChanged()
      void load()
    }
  })

  let first = true
  const load = async () => {
    try {
      const tasks = await Store.tasks(filter, 500)
      if (first) {
        // 首次打开时展开未完成的记录
        for (const t of tasks) if (t.status === 'pending') open.add(t.id)
        first = false
      }
      render(tasks)
    } catch (err) {
      m.body.innerHTML = `<div class="rec-empty c-danger">${esc(errText(err))}</div>`
    }
  }
  void load()
}
