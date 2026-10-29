import numpy as np, pandas as pd
from hedge_liq import run_h
from futures_bt import spot_bars
from repo_sys import trend_state
SB = {s: spot_bars(s) for s in ["BTC", "ETH"]}
cur = {}
for name, kw in [("A 基础版", dict(w=0.0, carry=False)), ("E 套利版", dict(w=0.0)), ("H 对冲版", dict(w=0.3))]:
    cur[name] = sum(run_h(b, "2017-10-17", **kw)[0] for b in SB.values()) / 2
cur["买入持有"] = sum(b.c["2017-10-17":] / b.c["2017-10-17"] for b in SB.values()) / 2
rows = []
for name, e in cur.items():
    e = e.dropna()
    for days in (91, 182, 365, 730):
        r = (e.shift(-days) / e - 1).dropna()
        rows.append(dict(方案=name, 窗口=f"{days}天", 亏损概率=(r < 0).mean(), 中位=r.median(), P10=r.quantile(.1), P90=r.quantile(.9), 最差=r.min()))
pd.set_option("display.width", 250)
print(pd.DataFrame(rows).round(3).to_string(index=False))
# H 相对 A：3 个月内 H 跑赢 A 的概率
h, a = cur["H 对冲版"].dropna(), cur["A 基础版"].dropna()
for days in (91, 365):
    d = (h.shift(-days) / h) - (a.shift(-days) / a); d = d.dropna()
    print(f"{days}天内 H 跑赢 A 的概率 {(d > 0).mean():.0%}")
for s, b in SB.items():
    st, _, _ = trend_state(b.h.values, b.l.values, b.c.values)
    print(s, "平均每 3 个月翻转", round(np.sum(np.diff(st) != 0) / (len(st) / 91), 1), "次")
