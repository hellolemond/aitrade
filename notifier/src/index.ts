import { fetchKlines } from './lib/binance.ts'
import { trendChannel } from './lib/indicators.ts'
import type { ChannelPoint } from './lib/types.ts'
import { sendWecomMarkdown } from './notify/wecom.ts'
import { applyFlip, initLedger, rebalance, valuation, type Ledger, type Step } from './strategy/hPlan.ts'

export interface Env {
  STATE: KVNamespace
  /** 企业微信群机器人 Webhook（secret） */
  WECOM_WEBHOOK: string
  /** 手动接口的访问令牌（secret） */
  TRIGGER_TOKEN: string
  /** 首次运行时的初始资金（USDT） */
  CAPITAL: string
  /** "true" 时每天都发日报；否则只在翻转、再平衡、初始化时发送 */
  DAILY_REPORT?: string
}

const SYMBOL = 'BTCUSDT'
const LEDGER_KEY = 'ledger:BTC:H'
const DAY_MS = 86_400_000

interface Signal {
  point: ChannelPoint
  close: number
  /** 已收盘日线的开盘时间 */
  candleTime: number
}

async function latestSignal(): Promise<Signal> {
  const candles = (await fetchKlines(SYMBOL, '1d')).filter((c) => c.closed)
  if (candles.length < 300) throw new Error(`已收盘日线只有 ${candles.length} 根，不足以推演趋势状态`)
  const ch = trendChannel(candles)
  const last = candles[candles.length - 1]
  return { point: ch.points[ch.points.length - 1], close: last.close, candleTime: last.time }
}

/** 北京时间日期，如 2026-10-29 */
function bjDate(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)
}

function fmt(n: number, d = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function render(title: string, sig: Signal, steps: Step[], ledger: Ledger): string {
  const { point, close } = sig
  const bull = point.state === 1
  const trigger = bull
    ? `收盘 < 下轨 ${fmt(point.lower)} 转空（距离 ${((close / point.lower - 1) * 100).toFixed(1)}%）`
    : `收盘 > 上轨 ${fmt(point.upper)} 转多（距离 ${((point.upper / close - 1) * 100).toFixed(1)}%）`
  const v = valuation(ledger, close)
  const lines = [
    `### ${title}`,
    `> 日线 ${bjDate(sig.candleTime + DAY_MS)} 08:00 收盘：**${fmt(close, 1)}**`,
    `> 上轨 ${fmt(point.upper)}　下轨 ${fmt(point.lower)}`,
    `> 状态：<font color="${bull ? 'warning' : 'info'}">${bull ? '多头' : '空头'}</font>　下次：${trigger}`,
    '',
  ]
  if (steps.length) {
    lines.push('**操作**')
    steps.forEach((s, i) => lines.push(`${i + 1}. 【${s.account}】${s.text}`))
    lines.push('')
  }
  const m = ledger.main
  const s = ledger.sleeve
  lines.push(
    '**建议账本（按收盘价估算，未计资金费）**',
    `> 主仓：${fmt(m.btc, 6)} BTC + ${fmt(m.usdt, 2)} USDT${m.hedgeContracts ? `，币本位空 ${m.hedgeContracts} 张 @${fmt(m.hedgeEntry)}` : ''}`,
    `> 空单仓：${fmt(s.usdt, 2)} USDT${s.shortQty ? `，U 本位空 ${s.shortQty} BTC @${fmt(s.shortEntry)}` : ''}`,
    `> 估值：主仓 ${fmt(v.main, 0)} + 空单仓 ${fmt(v.sleeve, 0)} = **${fmt(v.total, 0)} USDT**`,
  )
  return lines.join('\n')
}

interface RunOptions {
  /** 忽略「今天已处理」直接重跑（不改变账本，除非确有新信号） */
  force?: boolean
  /** 只计算不保存、不发送 */
  dry?: boolean
}

async function run(env: Env, opts: RunOptions = {}): Promise<{ message: string | null; ledger: Ledger }> {
  const sig = await latestSignal()
  const raw = await env.STATE.get(LEDGER_KEY)
  const year = new Date(sig.candleTime + DAY_MS).getUTCFullYear()   // 新一根日线所在年份

  let ledger: Ledger
  let title: string
  const steps: Step[] = []

  if (!raw) {
    const r = initLedger(Number(env.CAPITAL), sig.point.state, sig.close, sig.candleTime, year)
    ledger = r.ledger
    steps.push(...r.steps)
    title = `BTC H 方案：初始建仓（${fmt(Number(env.CAPITAL))} USDT）`
  } else {
    ledger = JSON.parse(raw) as Ledger
    if (ledger.lastCandleTime >= sig.candleTime && !opts.force) {
      return { message: null, ledger }
    }
    title = 'BTC H 方案：日报'
    if (sig.point.state !== ledger.state) {
      const r = applyFlip(ledger, sig.point.state, sig.close)
      ledger = r.ledger
      steps.push(...r.steps)
      title = `BTC H 方案：<font color="warning">趋势翻转 → ${sig.point.state === 1 ? '转多' : '转空'}</font>`
    }
    if (year > ledger.lastRebalanceYear) {
      const r = rebalance(ledger, sig.close, year)
      ledger = r.ledger
      steps.push(...r.steps)
      title += `　${year} 年度再平衡`
    }
    ledger.lastCandleTime = sig.candleTime
  }

  const shouldSend = steps.length > 0 || env.DAILY_REPORT === 'true'
  const message = shouldSend ? render(title, sig, steps, ledger) : null
  if (!opts.dry) {
    // 先发消息再保存：发送失败时账本不前进，下一次定时任务会重试
    if (message) await sendWecomMarkdown(env.WECOM_WEBHOOK, message)
    await env.STATE.put(LEDGER_KEY, JSON.stringify(ledger))
  }
  return { message, ledger }
}

async function alert(env: Env, err: unknown): Promise<void> {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  try {
    await sendWecomMarkdown(env.WECOM_WEBHOOK, `### <font color="warning">BTC H 方案：运行失败</font>\n> ${text.slice(0, 1500)}\n\n稍后定时任务会自动重试；若持续失败请手动检查。`)
  } catch {
    // 通知渠道本身失败时只能留在日志里
  }
}

function unauthorized(req: Request, env: Env): boolean {
  const url = new URL(req.url)
  const token = url.searchParams.get('token') ?? req.headers.get('authorization')?.replace(/^Bearer /, '')
  return !env.TRIGGER_TOKEN || token !== env.TRIGGER_TOKEN
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      run(env).catch(async (err) => {
        console.error(err)
        await alert(env, err)
      }),
    )
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (unauthorized(req, env)) return new Response('unauthorized', { status: 401 })

    try {
      // 查看当前信号与账本，不发送
      if (url.pathname === '/status') {
        const r = await run(env, { dry: true, force: true })
        return Response.json(r)
      }
      // 手动执行一次：?dry=1 只预览；?force=1 忽略「今天已处理」
      if (url.pathname === '/run' && req.method === 'POST') {
        const r = await run(env, { dry: url.searchParams.has('dry'), force: url.searchParams.has('force') })
        return Response.json(r)
      }
      // 同步账本：实际持仓与建议有出入时，PUT 完整的账本 JSON
      if (url.pathname === '/ledger' && req.method === 'PUT') {
        const body = (await req.json()) as Ledger
        await env.STATE.put(LEDGER_KEY, JSON.stringify(body))
        return Response.json({ ok: true, ledger: body })
      }
      // 清空账本，下次运行重新初始化
      if (url.pathname === '/ledger' && req.method === 'DELETE') {
        await env.STATE.delete(LEDGER_KEY)
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 500 })
    }
  },
} satisfies ExportedHandler<Env>
