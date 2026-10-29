"""BTC、ETH 各 1000U，2017-08 ~ 2026-09 连续回测，比较卖法组合。档位：线性 1%×95 档×10.5U。"""
import itertools, numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from engine2 import run_sched
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
CAP, FEE, W = 1000., 0.001, 365 * 1440
LV = np.arange(1, 96) * 0.01; AM = np.full(95, CAP / 95)
SELL = {"单批+5%": (0, 0.05), "整体+3%": (1, 0.03), "整体+5%": (1, 0.05), "单批+3%": (0, 0.03)}
D = {s: load(f"data/{s.lower()}usdt_1m_2017_2026.npz") for s in ["btc", "eth"]}
# 对齐到共同的起点
t0 = max(D[s][0][0] for s in D)
for s in D:
    i0 = int(np.searchsorted(D[s][0], t0)); D[s] = tuple(a[i0:] for a in D[s])

def daily(sym, sell, sl=slice(None)):
    ts, o, h, l, c = D[sym]; m, g = SELL[sell]
    st, eq, cd = run_sched(o[sl], h[sl], l[sl], c[sl], LV, AM, g, m, FEE, False)
    return eq[eq > 0], cd, st

def job(p):
    sym, sell = p
    e, cd, st = daily(sym, sell)
    n = len(D[sym][4]); wins = [daily(sym, sell, slice(x, x + W))[0] for x in range(0, n - W, 30 * 1440)]
    return (sym, sell), (e, cd, st, wins)

def met(e, yrs):
    pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    return dict(年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365))

if __name__ == "__main__":
    with Pool(8) as pool: R = dict(pool.map(job, list(itertools.product(["btc", "eth"], SELL))))
    ts = D["btc"][0]; yrs = len(ts) / 1440 / 365
    n = min(len(v[0]) for v in R.values()); days = pd.to_datetime(ts[::1440][:n], unit="ms")
    print(f"区间 {days[0].date()} ~ {days[-1].date()}  {yrs:.1f} 年")
    print("\n== 单币种")
    rows = []
    for (sym, sell), (e, cd, st, wins) in R.items():
        w = np.array([x[-1] / x[0] - 1 for x in wins])
        rows.append(dict(币=sym.upper(), 卖法=sell, **met(e[:n], yrs), 最大浮亏=st[2], 平均占用=cd.mean() / CAP, 交易次数=int(st[3]),
                         窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean()))
    print(pd.DataFrame(rows).round(3).to_string(index=False))
    print("\n== 组合（BTC 1000U + ETH 1000U）")
    rows, years = [], {}
    combos = [("单批+5%", "单批+5%"), ("整体+3%", "整体+3%"), ("单批+5%", "整体+3%"), ("整体+3%", "单批+5%"), ("整体+5%", "整体+5%")]
    for bs, es in combos:
        e = R[("btc", bs)][0][:n] + R[("eth", es)][0][:n]
        wb, we = R[("btc", bs)][3], R[("eth", es)][3]
        w = np.array([(a[-1] + b[-1]) / (a[0] + b[0]) - 1 for a, b in zip(wb, we)])
        name = f"BTC {bs} + ETH {es}"
        rows.append(dict(组合=name, **met(e, yrs), 期末U=e[-1], 窗口中位=np.median(w), 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean()))
        ye = pd.Series(e, index=days[:len(e)]).groupby(days[:len(e)].year).last(); years[name] = ye.diff().fillna(ye.iloc[0] - 2 * CAP)
    # 基准：各 20% 固定持有
    pxb, pxe = D["btc"][4][1439::1440], D["eth"][4][1439::1440]; n2 = min(n, len(pxb), len(pxe)); pxb, pxe = pxb[:n2], pxe[:n2]
    for wgt in (0.2, 0.3):
        e = [2 * CAP]
        for i in range(1, n2): e.append(e[-1] * (wgt * (pxb[i] / pxb[i - 1] + pxe[i] / pxe[i - 1]) / 2 + 1 - wgt))
        e = np.array(e); w = np.array([e[min(d + 365, n2 - 1)] / e[d] - 1 for d in range(0, n2 - 365, 30)])
        name = f"固定{int(wgt*100)}%持有(BTC/ETH各半)"
        rows.append(dict(组合=name, **met(e, yrs), 期末U=e[-1], 窗口中位=np.median(w), 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean()))
        ye = pd.Series(e, index=days[:len(e)]).groupby(days[:len(e)].year).last(); years[name] = ye.diff().fillna(ye.iloc[0] - 2 * CAP)
    print(pd.DataFrame(rows).round(3).to_string(index=False))
    print("\n== 组合逐年盈亏 U（本金 2000U）"); yd = pd.DataFrame(years); yd.columns = [c.replace(" + ", "+") for c in yd.columns]; print(yd.round(0).to_string())
