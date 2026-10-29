import { Account, Settings, Store, type Preferences, type Snapshot, type Task } from './mygo.ts'
import { fetchKlines } from './lib/binance.ts'
import { dailySignal, detect, type DailySignal } from './lib/hStrategy.ts'
import { openRecords, openSettings, type SettingsTab } from './ui/dialogs.ts'
import { errText } from './ui/dom.ts'
import { HPanel, type HPanelModel } from './ui/hPanel.ts'

const COLLAPSE_KEY = 'aitrade:hpanel-collapsed'

/** 日线与持仓的轮询间隔。信号只在每天 08:00 变化，5 分钟足够及时 */
const POLL_MS = 5 * 60_000

/**
 * BTC H 方案控制器：拉日线 → 检测信号 → 生成操作记录；拉持仓 → 核对是否与目标一致。
 *
 * 信号与数量都在本地算，下单仍在手机上完成；这里只记录「要做什么、做了没有」。
 */
export class HController {
  private readonly panel: HPanel
  private readonly badgeEl: HTMLElement | null
  private signal: DailySignal | null = null
  private signalError: string | null = null
  private price: number | null = null
  private keyConfigured = false
  private snapshot: Snapshot | null = null
  private snapshotError: string | null = null
  private syncing = false
  private pending: Task[] = []
  private totalTasks = 0
  /** 检测串行执行，避免两次轮询同时生成同一条记录 */
  private detecting: Promise<void> = Promise.resolve()

  constructor(root: HTMLElement, badgeEl: HTMLElement | null) {
    this.badgeEl = badgeEl
    this.panel = new HPanel(root, {
      onMarkStep: (id, done) => void this.mark(() => Store.markStep(id, done)),
      onMarkTask: (id) => void this.mark(() => Store.markTask(id)),
      onRefresh: () => void this.syncHoldings(),
      onOpenRecords: () => openRecords(() => void this.loadTasks()),
      onOpenSettings: () => this.openSettings('api'),
      onCollapse: () => this.setCollapsed(true),
    })
    this.setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    this.render()
  }

  async start(): Promise<void> {
    await this.loadKeyStatus()
    await Promise.all([this.loadTasks(), this.syncHoldings()])
    await this.refreshSignal()
    setInterval(() => void this.tick(), POLL_MS)
    // 从睡眠唤醒或切回窗口时立即检查一次，不必等下一个轮询
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.tick()
    })
  }

  openSettings(tab?: SettingsTab): void {
    openSettings({
      tab,
      onKeyChanged: async () => {
        await this.loadKeyStatus()
        this.snapshot = null
        await this.syncHoldings()
      },
      onPrefs: (p) => this.onPrefs?.(p),
    })
  }

  /** 基础设置变化时的回调，由 main 设置（更新图表与界面配色） */
  onPrefs: ((p: Preferences) => void) | null = null

  /** 收起 / 展开右侧 H 方案面板，记住上次的选择 */
  setCollapsed(collapsed: boolean): void {
    document.body.classList.toggle('hpanel-collapsed', collapsed)
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }

  toggleCollapsed(): void {
    this.setCollapsed(!document.body.classList.contains('hpanel-collapsed'))
  }

  /** 主图在看 BTCUSDT 时把实时价格传进来，持仓估值更及时 */
  setLivePrice(price: number): void {
    this.price = price
  }

  private async tick(): Promise<void> {
    await this.syncHoldings()
    await this.refreshSignal()
  }

  private async loadKeyStatus(): Promise<void> {
    try {
      this.keyConfigured = (await Settings.status()).configured
    } catch {
      this.keyConfigured = false
    }
    this.render()
  }

  private async loadTasks(): Promise<void> {
    try {
      const [pending, all] = await Promise.all([Store.tasks('pending', 20), Store.tasks('', 1000)])
      this.pending = pending.reverse() // 先发生的在上面
      this.totalTasks = all.length
    } catch (err) {
      console.error(err)
    }
    this.render()
  }

  private async syncHoldings(): Promise<void> {
    if (!this.keyConfigured || this.syncing) return
    this.syncing = true
    this.render()
    try {
      this.snapshot = await Account.snapshot()
      this.snapshotError = null
    } catch (err) {
      this.snapshotError = errText(err)
    } finally {
      this.syncing = false
      this.render()
    }
  }

  private refreshSignal(): Promise<void> {
    this.detecting = this.detecting.then(async () => {
      try {
        const candles = await fetchKlines('BTCUSDT', '1d', 1000)
        const live = candles[candles.length - 1]
        if (live) this.price = live.close
        this.signal = dailySignal(candles)
        this.signalError = this.signal ? null : '日线数据不足'
      } catch (err) {
        this.signalError = `拉取 BTC 日线失败：${errText(err)}`
      }
      this.render()
      if (!this.signal) return

      try {
        const stored = await Store.strategyState()
        // 生成记录要用最新持仓，避免数量按几分钟前的余额算
        if (this.keyConfigured && stored && this.signal.candleTime > stored.lastCandleTime) await this.syncHoldings()
        const holdings = this.snapshotError ? null : this.snapshot
        const d = detect(this.signal, stored, holdings)
        if (!d) return
        if (d.tasks.length === 0) {
          await Store.saveState(d.state)
          return
        }
        // 多条记录（同一天翻转 + 再平衡）时，进度只随最后一条保存
        for (const [i, t] of d.tasks.entries()) {
          const st = i === d.tasks.length - 1 ? d.state : (stored ?? d.state)
          await Store.createTask({ ...t, steps: t.steps.map((s) => ({ ...s })) }, st)
        }
        await this.loadTasks()
      } catch (err) {
        console.error('生成操作记录失败', err)
      }
    })
    return this.detecting
  }

  private async mark(fn: () => Promise<Task>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      alert(errText(err))
    }
    await this.loadTasks()
    // 标记后重新读取持仓，确认手机上的操作已生效
    void this.syncHoldings()
  }

  private render(): void {
    const model: HPanelModel = {
      signal: this.signal,
      signalError: this.signalError,
      price: this.price,
      keyConfigured: this.keyConfigured,
      snapshot: this.snapshot,
      snapshotError: this.snapshotError,
      syncing: this.syncing,
      pending: this.pending,
      totalTasks: this.totalTasks,
    }
    this.panel.render(model)
    if (this.badgeEl) {
      const n = this.pending.reduce((k, t) => k + t.steps.filter((s) => !s.doneAt).length, 0)
      this.badgeEl.textContent = String(n)
      this.badgeEl.parentElement!.hidden = n === 0
    }
  }
}
