import { Store } from '../mygo.ts'
import { DEFAULT_WATCHLIST } from './types.ts'

/**
 * 把用户输入规整为交易对名。
 *
 * 只收 USDT 计价：输入 `doge`、`DOGE`、`doge/usdt` 都得到 `DOGEUSDT`。
 * 含非法字符的返回 null，交给调用方提示。
 */
export function normalizeSymbol(input: string): string | null {
  const base = input.toUpperCase().replace(/[\s/_-]/g, '').replace(/USDT$/, '')
  if (!/^[A-Z0-9]{1,20}$/.test(base)) return null
  return `${base}USDT`
}

/** 读取自选列表（本地 SQLite）。读取失败时回落到默认列表，保证至少有一个币可看 */
export async function loadWatchlist(): Promise<string[]> {
  try {
    const list = (await Store.watchlist()).filter((s) => s.endsWith('USDT'))
    return list.length > 0 ? list : [...DEFAULT_WATCHLIST]
  } catch {
    return [...DEFAULT_WATCHLIST]
  }
}

export function saveWatchlist(list: readonly string[]): void {
  Store.setWatchlist([...list]).catch((err) => console.error('保存自选列表失败', err))
}
