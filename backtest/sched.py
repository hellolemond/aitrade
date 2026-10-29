"""不同档位表（线性/分段/递增间隔/加码）× 两种卖法 × 7 组数据集。"""
import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from engine2 import run_sched
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)
CAP, FEE, W = 1000., 0.001, 365 * 1440

def norm(a): a = np.asarray(a, float); return a / a.sum() * CAP
def sched():
    S = {}
    k = np.arange(1, 81); S["旧E 复利1%×80(55%)"] = (1 - 0.99 ** k, norm(np.ones(80)))
    S["线性1%×90(90%)"] = (np.arange(1, 91) * 0.01, norm(np.ones(90)))
    S["线性1%×95(95%)"] = (np.arange(1, 96) * 0.01, norm(np.ones(95)))
    seg = np.r_[np.arange(1, 31) * 0.01, 0.30 + np.arange(1, 27) * 0.025]
    S["分段1%→2.5%(95%)等额"] = (seg, norm(np.ones(56)))
    S["分段1%→2.5%(95%)加码"] = (seg, norm(np.r_[np.full(30, 10.), np.full(26, 700 / 26)]))
    i = np.arange(1, 61); b = (0.95 - 0.6) / 3600; inc = 0.01 * i + b * i ** 2
    S["递增间隔(95%)等额"] = (inc, norm(np.ones(60)))
    S["递增间隔(95%)加码"] = (inc, norm(1 + i / 60))
    return S
S = sched()
SETS = {f"{s[:3]}样本内": f"data/{s.lower()}_1m.npz" for s in ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]}
SETS.update({f"{s[:3]}样本外": f"data/{s.lower()}_1m_2017_2019.npz" for s in ["BTCUSDT", "ETHUSDT", "BNBUSDT"]})
_cache = {}
def data(k):
    if k not in _cache: _cache[k] = load(SETS[k])
    return _cache[k]

def met(e, yrs):
    pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    return (e[-1] / e[0]) ** (1 / yrs) - 1, ((e - pk) / pk).min(), r.mean() / r.std() * np.sqrt(365)

def job(p):
    ds, name, sell, g = p
    ts, o, h, l, c = data(ds); lv, am = S[name]; yrs = len(c) / 1440 / 365
    st, eq, cd = run_sched(o, h, l, c, lv, am, g, sell, FEE, False)
    ann, mdd, sh = met(eq[eq > 0], yrs)
    w = np.array([run_sched(o[x:x+W], h[x:x+W], l[x:x+W], c[x:x+W], lv, am, g, sell, FEE, False)[0][0] / CAP
                  for x in range(0, len(c) - W, 30 * 1440)])
    return dict(数据=ds, 档位=name, 卖法="单批+5%" if sell == 0 else "整体+3%", 年化=ann, 最大回撤=mdd, 夏普=sh,
                最大浮亏=st[2], 买满次数=int(st[1]), 平均占用=cd.mean() / CAP, 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean())

def bench(ds):
    ts, o, h, l, c = data(ds); px = c[1439::1440]; yrs = len(c) / 1440 / 365; out = []
    for wgt in (0.2, 0.3):
        e = [CAP]
        for i in range(1, len(px)): e.append(e[-1] * (wgt * px[i] / px[i - 1] + 1 - wgt))
        e = np.array(e); ann, mdd, sh = met(e, yrs)
        w = np.array([e[min(d + 365, len(e) - 1)] / e[d] - 1 for d in range(0, len(e) - 365, 30)])
        out.append(dict(数据=ds, 档位=f"固定{int(wgt*100)}%持有", 卖法="-", 年化=ann, 最大回撤=mdd, 夏普=sh, 窗口P10=np.percentile(w, 10), 窗口最差=w.min(), 亏损窗口=(w < 0).mean()))
    return out

if __name__ == "__main__":
    ps = [(d, n, s, g) for d in SETS for n in S for s, g in [(0, 0.05), (1, 0.03)]]
    with Pool(8) as pool: df = pd.DataFrame(pool.map(job, ps, chunksize=2))
    df = pd.concat([df, pd.DataFrame([r for d in SETS for r in bench(d)])], ignore_index=True)
    df.to_csv("sched.csv", index=False)
    for d in SETS:
        print(f"\n######## {d}"); print(df[df.数据 == d].drop(columns="数据").round(3).to_string(index=False))
    print("\n######## 7 组数据平均")
    print(df.groupby(["档位", "卖法"])[["年化", "最大回撤", "夏普", "最大浮亏", "窗口P10", "窗口最差", "亏损窗口"]].mean().round(3).to_string())
    print("\n######## 最差的数据集表现（每个方案取 7 组里的最小值）")
    print(df.groupby(["档位", "卖法"])[["年化", "最大回撤", "最大浮亏", "窗口最差"]].min().round(3).to_string())
