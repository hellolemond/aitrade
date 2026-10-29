# AiTrade 桌面端

基于 [mygo](https://mygo.egoist.dev/) 的本地应用。左侧是 [hellolemond/t](https://github.com/hellolemond/t) 的趋势通道图表与自选矩阵（样式、功能保持一致，周期增加 5 分钟），右侧是 BTC H 方案面板。

**只读**：程序只向币安发 GET 请求，下单、平仓、划转都在手机上完成。转多/转空提醒由 `../notifier`（Cloudflare Worker + 企业微信）负责，本应用不必常开。

## 功能

| 区域 | 内容 |
|---|---|
| 图表 | K 线 + EMA32 高低通道 + MACD，周期 5m / 15m / 1h / 4h / 1d / 1w |
| 自选边栏 | 搜索添加、删除币种，默认 BTCUSDT，存在本地 SQLite |
| H 方案 · 信号 | BTC 日线状态、上下轨、距离翻转多远 |
| H 方案 · 待执行操作 | 日线收盘出现翻转、年度再平衡或首次运行时自动生成一条记录，数量按实际持仓计算；手机上操作完逐步打勾或整条「标记已操作」 |
| H 方案 · 实际持仓 | 现货、币本位、U 本位三个账户，逐个核对是否与目标一致；杠杆不是 1 倍、不是逐仓等会提示 |
| 操作记录 | 全部 / 未完成 / 已完成筛选，可撤销标记；新信号会把未完成的旧记录标为「已被新信号取代」 |
| 设置 | 只有币安 API Key。保存前检查权限，开了交易、提现、划转的 Key 拒绝保存；Key 存系统钥匙串 |

## 结构

```
main.go          窗口与服务绑定
binance.go       签名的只读 GET 客户端（自动校正服务器时间）
account.go       Key 管理（钥匙串、权限检查）与三账户持仓快照
store.go         SQLite：自选、策略进度、操作记录
app_test.go      Go 单测（数据库、权限判定、持仓解析，用 httptest 模拟币安）
src/lib/         t 仓库的指标与行情代码；hPlan.ts（与 notifier 相同）；hStrategy.ts（信号检测与对账）
src/ui/          t 仓库的图表与边栏；hPanel.ts、dialogs.ts
src/hController.ts  拉日线 → 检测信号 → 生成记录；拉持仓 → 核对
```

## 开发

需要 Go 1.27.3+（`go.mod` 已声明，旧版本 Go 会自动下载工具链）和 Bun。

```bash
bun install
bun run dev        # 开发版，改代码自动重载（Vite 端口 5188）
bun run test       # 前端 node 单测 + go test
bun run typecheck
bun run build      # 打包到 build/
```

本机 Go 低于 1.27 时，先把 1.27 工具链放进 PATH：

```bash
export PATH="$(GOTOOLCHAIN=go1.27.3 go env GOROOT)/bin:$PATH"
```

数据库在 `~/Library/Application Support/AiTrade/aitrade.db`（开发版为 `AiTrade Dev`）。
