/**
 * 企业微信群机器人。
 *
 * 群设置 → 群机器人 → 添加机器人，复制 Webhook 地址（含 key），
 * 以 secret 形式保存：`npx wrangler secret put WECOM_WEBHOOK`。
 * markdown 消息内容上限 4096 字节。
 */
export async function sendWecomMarkdown(webhook: string, content: string): Promise<void> {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  })
  const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
  if (!res.ok || body.errcode !== 0) {
    throw new Error(`企业微信发送失败（HTTP ${res.status}，errcode ${body.errcode}：${body.errmsg ?? ''}）`)
  }
}
