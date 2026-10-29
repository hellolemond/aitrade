import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from engine3 import run_trend
from repo_sys import daily_bars, target_weights, run_weights
from repo_bt import SETS, met, LV, AM, FEE
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)

def curves(ds):
    ts, o, h, l, c = load(SETS[ds]); yrs = len(c) / 1440 / 365
    db = daily_bars(ts, o, h, l, c); first = db.index[0]; db = db.reindex(range(first, db.index[-1] + 1)).ffill()
    O, H, L, C = (db[k].values for k in "ohlc")
    t1, _ = target_weights(H, L, C, False); t2, _ = target_weights(H, L, C, True)
    out = {}
    for w in (0.3, 0.4, 0.5, 1.0):
        out[f"纯趋势 仓位{int(w*100)}%"] = run_weights(O, C, t1 * w)[0]
        out[f"趋势+结构 仓位{int(w*100)}%"] = run_weights(O, C, t2 * w)[0]
    day = (ts // 86_400_000) - first; nan = np.full(len(C), np.nan)
    out["网格 整体+3%"] = run_trend(o, h, l, c, day, nan, nan, LV, AM, 0.03, 1, FEE, False, 0.0)[1][:len(C)]
    out["网格 单批+5%"] = run_trend(o, h, l, c, day, nan, nan, LV, AM, 0.05, 0, FEE, False, 0.0)[1][:len(C)]
    out["固定30%持有"] = run_weights(O, C, np.full(len(C), 0.3))[0]
    return ds, yrs, out

if __name__ == "__main__":
    with Pool(8) as pool: res = pool.map(curves, list(SETS))
    rows = []; R = {}
    for ds, yrs, out in res:
        R[ds] = (yrs, out)
        for k, e in out.items(): rows.append(dict(数据=ds, 方案=k, **met(e, yrs)))
    df = pd.DataFrame(rows); order = list(res[0][2].keys())
    for k in ["年化", "最大回撤", "夏普"]:
        print(f"== {k}"); print(df.pivot_table(index="方案", columns="数据", values=k).reindex(order).round(2).to_string()); print()
    ind = ["BTC样本内", "ETH样本内", "BNB样本内", "SOL样本内", "BTC样本外", "ETH样本外", "BNB样本外"]
    print("== 7 组独立数据中位数"); print(df[df.数据.isin(ind)].groupby("方案")[["年化", "最大回撤", "夏普", "最差1年"]].median().reindex(order).round(3).to_string())
    yrs, ob = R["BTC全程"]; _, oe = R["ETH全程"]
    print("\n== BTC、ETH 各 1000U（2017-2026）")
    pr = []
    combos = [("网格 整体+3%", "网格 单批+5%")] + [(f"{s} 仓位{w}%",) * 2 for s in ["纯趋势", "趋势+结构"] for w in (30, 40, 50, 100)] + [("固定30%持有",) * 2]
    for bk, ek in combos:
        n = min(len(ob[bk]), len(oe[ek])); e = ob[bk][:n] + oe[ek][:n]
        pr.append(dict(BTC=bk, ETH=ek, **met(e, yrs), 期末=e[-1]))
    print(pd.DataFrame(pr).round(3).to_string(index=False))
