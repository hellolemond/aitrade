import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load, run_shadow, run_grid, summarize
pd.set_option("display.width", 250)
ts, o, h, l, c = load(); CAP=1000.; FEE=0.001; YRS=len(c)/1440/365; W=365*1440
starts = list(range(0, len(c)-W, 30*1440))

def call(kind, step, amt, tp, sl=slice(None)):
    a = (o[sl],h[sl],l[sl],c[sl])
    if kind == "整体卖": return run_shadow(*a, step, amt, CAP, tp, 1.0, 1.0, step, FEE, 5., 1, False)
    return run_grid(*a, step, amt, CAP, tp, FEE, False)

def job(p):
    kind, step, amt, tp = p
    st, eq, cd = call(kind, step, amt, tp)
    r = summarize(st, eq, cd, CAP, YRS)
    w = np.array([call(kind, step, amt, tp, slice(s, s+W))[0][0]/CAP for s in starts])
    return dict(方式=kind, 间隔=step, 每档=amt, 止盈=tp, 年化=r["年化(按cap)"], 最大回撤=r["最大回撤"],
                平均占用=r["平均占用"], 卖出次数=r["卖出次数"], 手续费=r["手续费U"],
                窗口中位=np.median(w), 窗口P10=np.percentile(w,10), 窗口最差=w.min())

if __name__ == "__main__":
    ps = [(k, s, a, t) for (s, a) in [(0.01, 12.5), (0.005, 10.)] for t in [0.02, 0.03, 0.05, 0.08, 0.10] for k in ["单批止盈", "整体卖"]]
    with Pool(8) as pool: rows = pool.map(job, ps)
    df = pd.DataFrame(rows)
    print(df.round(3).to_string(index=False))
