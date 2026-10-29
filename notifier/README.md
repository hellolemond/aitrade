# BTC H 方案信号通知（Cloudflare Worker + 企业微信）

每天北京时间 08:02（UTC 00:02）在日线收盘后计算 BTCUSDT 的 EMA32 高低通道状态，按[对冲版策略](../docs/趋势通道对冲版策略.md)给出操作建议，推送到企业微信群。**只通知，不下单，不需要币安 API Key。**

## 消息什么时候发

| 情况 | 内容 |
|---|---|
| 首次运行 | 初始建仓步骤（按 `CAPITAL` 资金） |
| 趋势翻转 | 主仓、空单仓各自要做的操作和数量 |
| 每年 1 月 1 日 | 70:30 再平衡步骤 |
| 运行失败 | 错误信息（00:17 的定时任务会自动重试） |
| 其他日子 | `DAILY_REPORT=true` 时发日报（状态、上下轨、距离翻转多远、账本估值） |

## 部署

```bash
cd notifier
npm install

# 1. 企业微信：群设置 → 群机器人 → 添加机器人，复制 Webhook 地址

# 2. 创建 KV，把返回的 id 填进 wrangler.jsonc 的 kv_namespaces
npx wrangler kv namespace create STATE

# 3. 保存密钥
npx wrangler secret put WECOM_WEBHOOK     # 粘贴 Webhook 地址
npx wrangler secret put TRIGGER_TOKEN     # 自己生成一串长随机字符串

# 4. 按需修改 wrangler.jsonc 的 vars：CAPITAL（初始资金）、DAILY_REPORT
npx wrangler deploy
```

部署后可以立刻手动执行一次，不必等到第二天 08:02：

```bash
curl -X POST "https://<worker 域名>/run?token=<TRIGGER_TOKEN>"
```

## 建议账本

Worker 在 KV 里维护一份「建议账本」：假设你按提醒成交，记录主仓的 BTC / USDT / 币本位空单张数，以及空单仓的 USDT / U 本位空单数量，用来计算下一次的下单数量。

- 价格按最新日线收盘价估算，手续费已计入，**资金费未计入**。
- 实际成交与账本有出入时（成交价不同、资金费、手动调整），用 `PUT /ledger` 同步为真实持仓，后续数量才会准确。

```bash
# 查看当前信号与账本（不发送、不保存）
curl "https://<worker 域名>/status?token=<TOKEN>"

# 同步账本（示例：主仓 0.0349 BTC 已在币本位开空 28 张，空单仓 1199 USDT 已开空 0.014 BTC）
curl -X PUT "https://<worker 域名>/ledger?token=<TOKEN>" -H 'content-type: application/json' -d '{
  "state": 0,
  "main":   { "usdt": 0, "btc": 0.0349, "hedgeContracts": 28, "hedgeEntry": 81343.5 },
  "sleeve": { "usdt": 1199, "shortQty": 0.014, "shortEntry": 81343.5 },
  "lastCandleTime": 1793145600000,
  "lastRebalanceYear": 2026
}'

# 清空账本，下次运行按 CAPITAL 重新初始化
curl -X DELETE "https://<worker 域名>/ledger?token=<TOKEN>"
```

`lastCandleTime` 是最后一根已处理日线的**开盘**时间（毫秒），可从 `/status` 的返回里复制。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 预览今天的信号与账本，不发送、不保存 |
| POST | `/run` | 执行一次；`?dry=1` 只预览，`?force=1` 忽略「今天已处理」 |
| PUT | `/ledger` | 用请求体覆盖账本 |
| DELETE | `/ledger` | 清空账本 |

所有接口都需要 `?token=` 或 `Authorization: Bearer <TOKEN>`。

## 开发

```bash
npm test          # 账本逻辑单测
npm run typecheck
cp .dev.vars.example .dev.vars   # 填入 Webhook 与 Token
npm run dev       # 本地运行；访问 /__scheduled 可模拟定时触发
```

## 代码来源

`src/lib/types.ts`、`src/lib/indicators.ts`（`ema`、`trendChannel`）、`src/lib/binance.ts`（`fetchKlines`）拷贝自 [hellolemond/t](https://github.com/hellolemond/t)。已用线上数据核对：与 `backtest/` 的 Python 实现结果一致（2026-10-28 上轨 82,712.05、下轨 80,718.33、空头、10-24 转空）。
