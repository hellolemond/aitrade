import numpy as np, pandas as pd
from engine import load
from repo_sys import daily_bars, target_weights, run_weights
from repo_bt import SETS
pd.set_option("display.width", 250)
C = {}
for sym in ["BTC", "ETH"]:
    ts, o, h, l, c = load(SETS[f"{sym}全程"])
    b = daily_bars(ts, o, h, l, c); b = b.reindex(range(b.index[0], b.index[-1] + 1)).ffill()
    O, H, L, Cl = (b[k].values for k in "ohlc"); idx = pd.to_datetime(b.index.values * 86_400_000, unit="ms")
    t1, st = target_weights(H, L, Cl, False); t2, _ = target_weights(H, L, Cl, True)
    C[f"{sym} 纯趋势"] = pd.Series(run_weights(O, Cl, t1, cap=2000.)[0], index=idx)
    C[f"{sym} 趋势+结构"] = pd.Series(run_weights(O, Cl, t2, cap=2000.)[0], index=idx)
    C[f"{sym} 买入持有"] = pd.Series(2000. * Cl / O[0], index=idx)
n = min(len(v) for v in C.values())
C = {k: v.iloc[:n] for k, v in C.items()}
C["BTC+ETH各半 纯趋势"] = C["BTC 纯趋势"] / 2 + C["ETH 纯趋势"] / 2
C["BTC+ETH各半 买入持有"] = C["BTC 买入持有"] / 2 + C["ETH 买入持有"] / 2
yrs = n / 365
rows = []
for k, e in C.items():
    v = e.values; pk = np.maximum.accumulate(v); dd = (v - pk) / pk; r = np.diff(v) / v[:-1]
    i = dd.argmin(); peak_i = v[:i + 1].argmax()
    # 回撤后回到前高所需天数
    rec = np.argmax(v[i:] >= pk[i]) if (v[i:] >= pk[i]).any() else None
    w = np.array([v[min(x + 365, n - 1)] / v[x] - 1 for x in range(0, n - 365, 30)])
    rows.append(dict(方案=k, 期末U=v[-1], 年化=(v[-1] / v[0]) ** (1 / yrs) - 1, 最大回撤=dd.min(), 最低时账户U=v[i],
                     回撤区间=f"{e.index[peak_i].date()}→{e.index[i].date()}", 回本天数=rec, 夏普=r.mean() / r.std() * np.sqrt(365),
                     最差1年=w.min(), 亏损窗口=(w < 0).mean(), 最大单日跌=r.min()))
print(pd.DataFrame(rows).round(3).to_string(index=False))
print("\n== 年末账户 U（起始 2000U，2017-08-17 开始）")
yd = pd.DataFrame({k: e.groupby(e.index.year).last() for k, e in C.items() if "结构" not in k})
print(yd.round(0).to_string())
print("\n== 当年收益 %")
prev = yd.shift(1); prev.iloc[0] = 2000; print(((yd / prev - 1) * 100).round(1).to_string())
