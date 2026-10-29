"""仓库趋势系统：4h 与日线对比。信号在 K 线收盘产生，下一根开盘执行。"""
import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from repo_sys import daily_bars, target_weights, run_weights
from repo_bt import SETS
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)
TF = {"日线": (86_400_000, True), "4h": (14_400_000, False)}

def met(e_day, yrs):
    e = e_day[e_day > 0]; pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    w = np.array([e[min(x + 365, len(e) - 1)] / e[x] - 1 for x in range(0, len(e) - 365, 30)])
    return dict(年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365), 最差1年=w.min(), 亏损窗口=(w < 0).mean())

def job(ds):
    ts, o, h, l, c = load(SETS[ds]); yrs = len(c) / 1440 / 365
    out = {}
    for tf, (ms, lg) in TF.items():
        b = daily_bars(ts, o, h, l, c, ms); b = b.reindex(range(b.index[0], b.index[-1] + 1)).ffill()
        O, H, L, C = (b[k].values for k in "ohlc"); per = 86_400_000 // ms
        off = (-b.index[0]) % per                       # 对齐到 UTC 日末
        t1, st = target_weights(H, L, C, False, lg); t2, _ = target_weights(H, L, C, True, lg)
        flips = int(np.sum(np.diff(st) != 0))
        for sname, t in (("纯趋势", t1), ("趋势+结构", t2)):
            for w in (0.3, 0.5, 1.0):
                for fee in (0.001, 0.002):
                    e, n_tr = run_weights(O, C, t * w, fee=fee)
                    ed = e[off + per - 1::per] if per > 1 else e
                    out[(tf, sname, w, fee)] = (met(ed, yrs), n_tr, flips, ed)
    return ds, yrs, out

if __name__ == "__main__":
    with Pool(8) as pool: res = pool.map(job, list(SETS))
    rows = []; R = {}
    for ds, yrs, out in res:
        R[ds] = (yrs, out)
        for (tf, s, w, fee), (m, ntr, fl, _) in out.items():
            rows.append(dict(数据=ds, 周期=tf, 方案=s, 仓位=w, 费率=fee, **m, 交易次数=ntr, 翻转次数=fl))
    df = pd.DataFrame(rows); df.to_csv("repo_4h.csv", index=False)
    base = df[(df.费率 == 0.001)]
    for k in ["年化", "最大回撤", "夏普"]:
        print(f"== {k}（费率 0.1%）"); print(base.pivot_table(index=["方案", "仓位", "周期"], columns="数据", values=k).round(2).to_string()); print()
    ind = ["BTC样本内", "ETH样本内", "BNB样本内", "SOL样本内", "BTC样本外", "ETH样本外", "BNB样本外"]
    print("== 7 组独立数据中位数")
    print(df[df.数据.isin(ind)].groupby(["方案", "仓位", "周期", "费率"])[["年化", "最大回撤", "夏普", "最差1年", "亏损窗口"]].median().round(3).to_string())
    print("\n== 每年翻转次数（BTC全程 / ETH全程）")
    for ds in ["BTC全程", "ETH全程"]:
        yrs, out = R[ds]
        for tf in TF: print(ds, tf, round(out[(tf, "纯趋势", 1.0, 0.001)][2] / yrs, 1), "次/年")
    print("\n== BTC、ETH 各 1000U（2017-2026）")
    yrs, ob = R["BTC全程"]; _, oe = R["ETH全程"]; pr = []
    for k in ob:
        n = min(len(ob[k][3]), len(oe[k][3])); e = ob[k][3][:n] + oe[k][3][:n]
        pr.append(dict(周期=k[0], 方案=k[1], 仓位=k[2], 费率=k[3], **met(e, yrs), 期末=e[-1]))
    print(pd.DataFrame(pr).sort_values(["费率", "方案", "仓位", "周期"]).round(3).to_string(index=False))
