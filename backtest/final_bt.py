"""最终方案回测：BTC、ETH 各 1000U，各跑各的，日线 EMA32 高低通道，100% 仓位，不加结构。"""
import numpy as np, pandas as pd
from engine import load
from repo_sys import daily_bars, trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
SRC = {"BTC": "data/btcusdt_1m_2017_2026.npz", "ETH": "data/ethusdt_1m_2017_2026.npz"}

def bars(sym):
    ts, o, h, l, c = load(SRC[sym]); b = daily_bars(ts, o, h, l, c)
    b = b.reindex(range(b.index[0], b.index[-1] + 1)).ffill()
    b.index = pd.to_datetime(b.index.values * 86_400_000, unit="ms"); return b

def run(b, fee=0.001, exec_at="open", cap=1000.0, start=None):
    """exec_at: open=次日开盘成交；close=当日收盘价成交（理想情况）。start: 从该日期起才允许交易（指标仍用全部历史推演）。"""
    st, up, lo = trend_state(b.h.values, b.l.values, b.c.values)
    O, C = b.o.values, b.c.values; n = len(C); idx = b.index
    i0 = 0 if start is None else int(np.searchsorted(idx, pd.Timestamp(start)))
    cash, qty = cap, 0.0; eq = np.full(n, np.nan); trades = []; entry = None
    for i in range(i0, n):
        sig = st[i - 1] if i > i0 else None             # 前一日收盘的状态
        if exec_at == "open" and sig is not None:
            px = O[i]
            if sig == 1 and qty == 0: qty = cash * (1 - fee) / px; entry = (idx[i], px, cash); cash = 0
            elif sig == 0 and qty > 0:
                cash = qty * px * (1 - fee); trades.append((entry[0], idx[i], entry[1], px, cash / entry[2] - 1, (idx[i] - entry[0]).days)); qty = 0
        if exec_at == "close":
            px = C[i]
            if st[i] == 1 and qty == 0 and i > i0: qty = cash * (1 - fee) / px; entry = (idx[i], px, cash); cash = 0
            elif st[i] == 0 and qty > 0:
                cash = qty * px * (1 - fee); trades.append((entry[0], idx[i], entry[1], px, cash / entry[2] - 1, (idx[i] - entry[0]).days)); qty = 0
        eq[i] = cash + qty * C[i]
    if qty > 0: trades.append((entry[0], idx[-1], entry[1], C[-1], qty * C[-1] / entry[2] - 1, (idx[-1] - entry[0]).days))
    e = pd.Series(eq, index=idx).dropna()
    t = pd.DataFrame(trades, columns=["买入日", "卖出日", "买价", "卖价", "收益", "持有天数"])
    return e, t

def met(e):
    v = e.values; yrs = len(v) / 365; pk = np.maximum.accumulate(v); dd = (v - pk) / pk; r = np.diff(v) / v[:-1]
    i = dd.argmin(); p = v[:i + 1].argmax(); rec = np.argmax(v[i:] >= pk[i]) if (v[i:] >= pk[i]).any() else -1
    # 最长水下期（低于前高的连续天数）
    under = dd < 0; longest = cur = 0
    for u in under: cur = cur + 1 if u else 0; longest = max(longest, cur)
    w = np.array([v[min(x + 365, len(v) - 1)] / v[x] - 1 for x in range(0, len(v) - 365, 30)])
    return dict(期末U=v[-1], 年化=(v[-1] / v[0]) ** (1 / yrs) - 1, 最大回撤=dd.min(), 回撤区间=f"{e.index[p].date()}→{e.index[i].date()}",
                触底后回本天=rec, 最长水下天=longest, 夏普=r.mean() / r.std() * np.sqrt(365), 最差1年=w.min(), 亏损1年窗口=(w < 0).mean())

def tstats(t):
    s = t.收益.values; win = s > 0; streak = cur = 0
    for x in s: cur = cur + 1 if x <= 0 else 0; streak = max(streak, cur)
    return dict(交易笔数=len(s), 胜率=win.mean(), 平均盈利=s[win].mean(), 平均亏损=s[~win].mean(), 盈亏比=s[win].mean() / -s[~win].mean(),
                最大单笔盈利=s.max(), 最大单笔亏损=s.min(), 最长连亏=streak, 平均持有天=t.持有天数.mean(), 持币时间占比=None)

if __name__ == "__main__":
    B = {s: bars(s) for s in SRC}
    n = min(len(b) for b in B.values()); B = {s: b.iloc[:n] for s, b in B.items()}
    R = {s: run(b) for s, b in B.items()}
    tot = R["BTC"][0] + R["ETH"][0]
    print("区间", tot.index[0].date(), "~", tot.index[-1].date(), f"{len(tot)/365:.1f} 年")
    print("\n== 1. 总体（BTC 1000U + ETH 1000U）")
    rows = [dict(账户=s, **met(R[s][0])) for s in SRC] + [dict(账户="合计", **met(tot))]
    for s, b in B.items(): rows.append(dict(账户=f"对照:{s}持有", **met(1000 * b.c / b.o.iloc[0])))
    print(pd.DataFrame(rows).round(3).to_string(index=False))
    print("\n== 2. 逐笔交易统计")
    tr = []
    for s in SRC:
        t = R[s][1]; d = tstats(t)
        st, _, _ = trend_state(B[s].h.values, B[s].l.values, B[s].c.values); d["持币时间占比"] = st.mean(); tr.append(dict(账户=s, **d))
    print(pd.DataFrame(tr).round(3).to_string(index=False))
    print("\n== 3. 年度（年末账户 U / 当年收益）")
    y = pd.DataFrame({s: R[s][0].groupby(R[s][0].index.year).last() for s in SRC}); y["合计"] = y.sum(axis=1)
    prev = y.shift(1); prev.iloc[0] = [1000, 1000, 2000]; g = (y / prev - 1) * 100
    print(pd.concat([y.round(0), g.round(1).add_suffix(" %")], axis=1).to_string())
    for s in SRC:
        t = R[s][1]; t["年"] = t.卖出日.dt.year
        print(f"-- {s} 每年交易笔数:", t.groupby("年").size().to_dict())
    print("\n== 4. 收益最大/亏损最大的 5 笔")
    for s in SRC:
        t = R[s][1].sort_values("收益")
        print(f"-- {s} 最亏"); print(t.head(5).round(3).to_string(index=False))
        print(f"-- {s} 最赚"); print(t.tail(5).round(3).to_string(index=False))
    print("\n== 5. 执行方式与手续费敏感性（合计）")
    rows = []
    for ex in ("open", "close"):
        for fee in (0.0005, 0.001, 0.002, 0.003):
            e = run(B["BTC"], fee, ex)[0] + run(B["ETH"], fee, ex)[0]
            rows.append(dict(成交=("次日开盘" if ex == "open" else "当日收盘"), 单边费率=fee, **{k: v for k, v in met(e).items() if k in ("期末U", "年化", "最大回撤", "夏普")}))
    print(pd.DataFrame(rows).round(3).to_string(index=False))
    print("\n== 6. 不同起点开始运行到 2026-09（合计 2000U）")
    rows = []
    for st_ in ["2017-12-17", "2018-06-01", "2019-06-26", "2020-03-13", "2021-04-14", "2021-11-10", "2022-06-18", "2023-01-01", "2024-03-14", "2025-01-01"]:
        e = run(B["BTC"], start=st_)[0] + run(B["ETH"], start=st_)[0]; m = met(e)
        hold = sum(1000 * B[s].c.iloc[-1] / B[s].o[B[s].index >= st_].iloc[0] for s in SRC)
        rows.append(dict(起点=st_, 期末U=m["期末U"], 年化=m["年化"], 最大回撤=m["最大回撤"], 对照持有期末U=hold))
    print(pd.DataFrame(rows).round(3).to_string(index=False))
