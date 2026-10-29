import itertools, numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load, run_shadow, run_grid, summarize

ts, o, h, l, c = load()
CAP, FEE, W = 1000.0, 0.001, 365 * 1440
starts = list(range(0, len(c) - W, 30 * 1440))
YRS = len(c) / 1440 / 365

def win_stats(fn, args):
    rets, mdds = [], []
    for s in starts:
        sl = slice(s, s + W)
        st, eq, cd = fn(o[sl], h[sl], l[sl], c[sl], *args)
        e = eq[eq > 0]; pk = np.maximum.accumulate(e)
        rets.append(st[0] / CAP); mdds.append(((e - pk) / pk).min())
    r = np.array(rets)
    return dict(窗口中位=np.median(r), 窗口P10=np.percentile(r, 10), 窗口最差=r.min(), 亏损窗口占比=(r < 0).mean(), 窗口回撤中位=np.median(mdds))

def job(p):
    kind, step, depth, tp, trail = p
    amt = CAP * step / depth
    if kind == "shadow":
        args = (step, amt, CAP, tp, 0.3, 5.0, step, FEE, 5.0, trail, False); fn = run_shadow
    else:
        args = (step, amt, CAP, tp, FEE, False); fn = run_grid
    st, eq, cd = fn(o, h, l, c, *args)
    r = summarize(st, eq, cd, CAP, YRS)
    r = {k: r[k] for k in ["年化(按cap)", "最大回撤", "最大浮亏(持仓)", "平均占用", "触顶次数"]}
    r["资金收益率"] = r["年化(按cap)"] / max(r["平均占用"], 1e-9)
    r.update(win_stats(fn, args))
    r.update(dict(kind=kind, step=step, amt=round(amt, 2), depth=depth, tp=tp, trail=trail))
    return r

if __name__ == "__main__":
    grid = [("shadow",) + x for x in itertools.product([0.005, 0.01, 0.015, 0.02], [0.3, 0.4, 0.5, 0.6, 0.8], [0.02, 0.03, 0.05, 0.08, 0.12], [0, 1])]
    grid += [("grid",) + x + (0,) for x in itertools.product([0.005, 0.01, 0.015, 0.02], [0.3, 0.4, 0.5, 0.6, 0.8], [0.02, 0.03, 0.05, 0.08, 0.12])]
    with Pool(8) as pool:
        rows = pool.map(job, grid, chunksize=4)
    df = pd.DataFrame(rows); df.to_csv("robust.csv", index=False)
    # 持有基准
    hold = [(c[s + W - 1] / o[s] - 1) for s in starts]
    print("持有BTC 1年窗口: 中位 %.3f P10 %.3f 最差 %.3f 亏损占比 %.2f" % (np.median(hold), np.percentile(hold, 10), min(hold), np.mean(np.array(hold) < 0)))
