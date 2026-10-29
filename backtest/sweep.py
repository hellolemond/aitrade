import itertools, numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load, run_shadow, run_grid, summarize

ts, o, h, l, c = load()
YRS = len(c) / 1440 / 365
CAP = 1000.0
FEE = 0.001
days = pd.to_datetime(ts[::1440][: len(c) // 1440 + 1], unit="ms")

def yearly(eq):
    s = pd.Series(eq[: len(days)], index=days[: len(eq)])
    s = s[s > 0]
    ye = s.groupby(s.index.year).last()
    prev = pd.concat([pd.Series([CAP]), ye.iloc[:-1]]).values
    return dict(zip(ye.index, (ye.values - prev)))

def job(p):
    step, amt, tp, fr, parts, sm, trail = p
    st, eq, cd = run_shadow(o, h, l, c, step, amt, CAP, tp, fr, parts, step * sm, FEE, 5.0, trail, False)
    r = summarize(st, eq, cd, CAP, YRS)
    r.update(dict(step=step, amt=amt, tp=tp, first=fr, parts=parts, sstep=step * sm, trail=trail))
    r.update({f"y{k}": v for k, v in yearly(eq).items()})
    return r

if __name__ == "__main__":
    grid = list(itertools.product(
        [0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03],
        [5.0, 10.0, 20.0, 50.0],
        [0.005, 0.01, 0.02, 0.03, 0.05],
        [0.3, 0.5, 1.0],
        [3.0, 5.0, 10.0],
        [1.0, 2.0],
        [0, 1]))
    with Pool(8) as pool:
        rows = pool.map(job, grid, chunksize=20)
    df = pd.DataFrame(rows)
    df["深度"] = CAP / df.amt * df.step
    df.to_csv("sweep_shadow.csv", index=False)
    g = []
    for step, amt, gg in itertools.product([0.003,0.005,0.0075,0.01,0.015,0.02,0.03],[5.,10.,20.,50.],[0.005,0.01,0.02,0.03,0.05]):
        st, eq, cd = run_grid(o, h, l, c, step, amt, CAP, gg, FEE, False)
        r = summarize(st, eq, cd, CAP, YRS); r.update(dict(step=step, amt=amt, g=gg)); r.update({f"y{k}": v for k, v in yearly(eq).items()})
        g.append(r)
    gd = pd.DataFrame(g); gd["深度"] = CAP / gd.amt * gd.step
    gd.to_csv("sweep_grid.csv", index=False)
    print(len(df), len(gd))
