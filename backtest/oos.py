"""样本外验证：沿用样本内结论的参数（不再优化），在 2017-2019 数据上检验。"""
import itertools, numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load, run_shadow, run_grid, summarize
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
CAP, FEE, W = 1000., 0.001, 365 * 1440
SYMS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"]
DATA = {s: load(f"data/{s.lower()}_1m_2017_2019.npz") for s in SYMS}

def call(sym, kind, step, amt, tp, sl=slice(None)):
    ts, o, h, l, c = DATA[sym]; a = (o[sl], h[sl], l[sl], c[sl])
    if kind == "单批止盈": return run_grid(*a, step, amt, CAP, tp, FEE, False)
    if kind == "整体卖": return run_shadow(*a, step, amt, CAP, tp, 1.0, 1.0, step, FEE, 5., 1, False)
    return run_shadow(*a, step, amt, CAP, tp, 0.3, 5.0, step, FEE, 5., 1, False)

def starts(sym):
    c = DATA[sym][4]; return list(range(0, len(c) - W, 30 * 1440))

def metrics(e, yrs):
    pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    return dict(总收益=e[-1] / e[0] - 1, 年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(),
                夏普=r.mean() / r.std() * np.sqrt(365) if r.std() > 0 else 0)

def job(p):
    sym, kind, step, depth, tp = p
    amt = CAP * step / depth; c = DATA[sym][4]; yrs = len(c) / 1440 / 365
    st, eq, cd = call(sym, kind, step, amt, tp); e = eq[eq > 0]
    m = metrics(e, yrs); s = summarize(st, eq, cd, CAP, yrs)
    w = np.array([call(sym, kind, step, amt, tp, slice(x, x + W))[0][0] / CAP for x in starts(sym)])
    m.update(币种=sym, 方式=kind, 间隔=step, 深度=depth, 止盈=tp, 最大浮亏=s["最大浮亏(持仓)"], 平均占用=s["平均占用"], 触顶=s["触顶次数"],
             期末持仓成本=s["期末持仓成本U"], 窗口中位=np.median(w), 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean())
    ts = DATA[sym][0]; days = pd.to_datetime(ts[::1440][:len(e)], unit="ms"); ye = pd.Series(e[:len(days)], index=days).groupby(days.year).last()
    prev = np.r_[CAP, ye.values[:-1]]
    for y, v in zip(ye.index, ye.values - prev): m[f"{y}盈亏U"] = v
    return m

def bench(sym, wgt):
    ts, o, h, l, c = DATA[sym]; px = c[1439::1440]; yrs = len(c) / 1440 / 365
    e = [CAP]
    for i in range(1, len(px)): e.append(e[-1] * (wgt * px[i] / px[i - 1] + 1 - wgt))
    e = np.array(e); m = metrics(e, yrs)
    w = np.array([e[min(d + 365, len(e) - 1)] / e[d] - 1 for d in range(0, len(e) - 365, 30)])
    m.update(币种=sym, 方式=f"固定{int(wgt*100)}%持有", 窗口中位=np.median(w), 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean())
    days = pd.to_datetime(ts[::1440][:len(e)], unit="ms"); ye = pd.Series(e[:len(days)], index=days).groupby(days.year).last()
    prev = np.r_[CAP, ye.values[:-1]]
    for y, v in zip(ye.index, ye.values - prev): m[f"{y}盈亏U"] = v
    return m

if __name__ == "__main__":
    pre = [("单批止盈", 0.01, 0.8, 0.05), ("单批止盈", 0.01, 0.9, 0.05), ("整体卖", 0.01, 0.8, 0.03), ("影子分批", 0.01, 0.8, 0.05)]
    rules = [(k, s, d, t) for k in ["单批止盈", "整体卖"] for s in [0.005, 0.01, 0.02] for d in [0.5, 0.8, 0.9] for t in [0.02, 0.03, 0.05, 0.08]]
    ps = [(sym,) + x for sym in SYMS for x in pre + rules]
    with Pool(8) as pool: df = pd.DataFrame(pool.map(job, ps, chunksize=2))
    df = df.drop_duplicates(["币种", "方式", "间隔", "深度", "止盈"])
    df.to_csv("oos.csv", index=False)
    bdf = pd.DataFrame([bench(s, w) for s in SYMS for w in (1.0, 0.3, 0.2)])
    for s in SYMS:
        c = DATA[s][4]; print(f"\n######## {s}  {c[0]:.2f} → {c[-1]:.2f}  区间内最大跌幅 {(c / np.maximum.accumulate(c)).min() - 1:.1%}")
        sel = pd.concat([df[(df.币种 == s) & df.apply(lambda r: (r.方式, r.间隔, r.深度, r.止盈) in pre, axis=1)], bdf[bdf.币种 == s]])
        cols = ["方式", "深度", "止盈", "总收益", "年化", "最大回撤", "夏普", "最大浮亏", "平均占用", "触顶", "期末持仓成本", "窗口中位", "窗口P10", "窗口最差", "亏损窗口"] + [c for c in sel.columns if c.endswith("盈亏U")]
        print(sel[[c for c in cols if c in sel.columns]].round(3).to_string(index=False))
    print("\n######## 规律检验（三币种均值）")
    r = df[df.apply(lambda x: (x.方式, x.间隔, x.深度, x.止盈) in [tuple(y) for y in rules], axis=1)]
    for k in ["间隔", "深度", "止盈", "方式"]:
        print(r.groupby(["币种", k])[["年化", "最大回撤", "窗口P10", "窗口最差"]].mean().unstack(0).round(3).to_string()); print()
