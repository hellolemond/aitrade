"""用法: python study.py ETHUSDT —— 网格扫描 + 滚动窗口 + 与整体卖/影子方案/固定比例持有对比。"""
import sys, itertools, numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load, run_shadow, run_grid, summarize
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
SYM = sys.argv[1] if len(sys.argv) > 1 else "ETHUSDT"
ts, o, h, l, c = load(f"data/{SYM.lower()}_1m.npz")
CAP, FEE, W = 1000., 0.001, 365 * 1440
YRS = len(c) / 1440 / 365
starts = list(range(0, len(c) - W, 30 * 1440))

def call(kind, step, amt, tp, sl=slice(None)):
    a = (o[sl], h[sl], l[sl], c[sl])
    if kind == "单批止盈": return run_grid(*a, step, amt, CAP, tp, FEE, False)
    if kind == "整体卖": return run_shadow(*a, step, amt, CAP, tp, 1.0, 1.0, step, FEE, 5., 1, False)
    return run_shadow(*a, step, amt, CAP, tp, 0.3, 5.0, step, FEE, 5., 1, False)  # 影子分批

def job(p):
    kind, step, depth, tp = p
    amt = CAP * step / depth
    st, eq, cd = call(kind, step, amt, tp)
    r = summarize(st, eq, cd, CAP, YRS)
    w = np.array([call(kind, step, amt, tp, slice(s, s + W))[0][0] / CAP for s in starts])
    return dict(方式=kind, 间隔=step, 深度=depth, 每档=round(amt, 2), 止盈=tp, 年化=r["年化(按cap)"], 最大回撤=r["最大回撤"],
                最大浮亏=r["最大浮亏(持仓)"], 平均占用=r["平均占用"], 触顶=r["触顶次数"], 卖出次数=r["卖出次数"],
                窗口中位=np.median(w), 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean())

def bench(e, name):
    r = np.diff(e) / e[:-1]; pk = np.maximum.accumulate(e)
    ann = (e[-1] / e[0]) ** (1 / YRS) - 1; mdd = ((e - pk) / pk).min()
    return dict(方案=name, 年化=ann, 最大回撤=mdd, 夏普=r.mean() / r.std() * np.sqrt(365), 收益回撤比=ann / -mdd)

if __name__ == "__main__":
    ps = [("单批止盈",) + x for x in itertools.product([0.005, 0.01, 0.015, 0.02], [0.5, 0.6, 0.8, 0.9], [0.02, 0.03, 0.05, 0.08, 0.10])]
    ps += [(k, 0.01, d, t) for k in ["整体卖", "影子分批"] for d in [0.6, 0.8, 0.9] for t in [0.03, 0.05, 0.08]]
    with Pool(8) as pool: df = pd.DataFrame(pool.map(job, ps, chunksize=2))
    df.to_csv(f"study_{SYM}.csv", index=False)
    g = df[df.方式 == "单批止盈"]
    print(f"===== {SYM}  价格 {o[0]:.0f} → {c[-1]:.0f}")
    print("== 单批止盈 单因素均值")
    for k in ["间隔", "深度", "止盈"]:
        print(g.groupby(k)[["年化", "最大回撤", "平均占用", "窗口中位", "窗口P10", "窗口最差", "亏损窗口"]].mean().round(3).to_string()); print()
    print("== 单批止盈 按窗口P10 top10"); print(g.sort_values("窗口P10", ascending=False).head(10).round(3).to_string(index=False))
    print("== 三种卖法对比 (间隔1%)")
    print(df[(df.间隔 == 0.01) & df.深度.isin([0.6, 0.8, 0.9]) & df.止盈.isin([0.03, 0.05, 0.08])].sort_values(["深度", "止盈", "方式"]).round(3).to_string(index=False))
    # 基准（日线口径，含滚动 1 年窗口）
    def daily(kind, step, amt, tp):
        st, eq, cd = call(kind, step, amt, tp); return eq[eq > 0]
    px_all = c[1439::1440]
    def roll(e):
        return np.array([e[min(d + 365, len(e) - 1)] / e[d] - 1 for d in range(0, len(e) - 365, 30)])
    def fixed(wgt, px):
        e = [CAP]
        for i in range(1, len(px)): e.append(e[-1] * (wgt * px[i] / px[i - 1] + 1 - wgt))
        return np.array(e)
    cands = {"单批止盈 1%/12.5U/+5%": ("单批止盈", 0.01, 12.5, 0.05), "整体卖 1%/12.5U/+3%": ("整体卖", 0.01, 12.5, 0.03),
             "影子分批 1%/12.5U/+3%": ("影子分批", 0.01, 12.5, 0.03)}
    curves = {k: daily(*v) for k, v in cands.items()}
    n = min(min(len(v) for v in curves.values()), len(px_all)); px = px_all[:n]
    curves = {k: v[:n] for k, v in curves.items()}
    curves["全仓持有"] = CAP * px / px[0]
    for wgt in (0.2, 0.3, 0.5): curves[f"固定{int(wgt*100)}%持有"] = fixed(wgt, px)
    rows = []
    for k, e in curves.items():
        b = bench(e, k); w = roll(e); b.update(窗口中位=np.median(w), 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean()); rows.append(b)
    print("== 基准对比"); print(pd.DataFrame(rows).round(3).to_string(index=False))
    days = pd.to_datetime(ts[::1440][:n], unit="ms")
    yd = pd.DataFrame({k: pd.Series(v, index=days).groupby(days.year).last() for k, v in curves.items() if not k.startswith("固定2")})
    yd = yd.diff().fillna(yd.iloc[0] - CAP)
    yd["币价涨跌"] = pd.Series(px, index=days).groupby(days.year).agg(lambda x: x.iloc[-1] / x.iloc[0] - 1)
    print("== 逐年盈亏U"); print(yd.round(1).to_string())
