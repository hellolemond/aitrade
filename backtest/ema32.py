import numpy as np, pandas as pd
from multiprocessing import Pool
from trend import SETS, data, job, LV, AM, FEE
from engine3 import run_trend
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)
VAR = [("单批+5%", 0, 0.05, 0.0), ("整体+3%", 1, 0.03, 0.0), ("整体+3%留50%", 1, 0.03, 0.5)]
CHS = ["无通道", "EMA32高低通道", "布林20,2σ", "线性回归50"]

def curve(ds, chn, sell, g, runner):
    o, h, l, c, day, ch = data(ds); up, ex = ch[chn]
    use = chn != "无通道" and runner == 0
    return run_trend(o, h, l, c, day, up, ex, LV, AM, g, sell, FEE, use, runner)[1]

def met(e, yrs):
    e = e[e > 0]; pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    w = np.array([e[min(x + 365, len(e) - 1)] / e[x] - 1 for x in range(0, len(e) - 365, 30)])
    return dict(年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365), 最差1年=w.min(), 期末=e[-1])

if __name__ == "__main__":
    ps = [(d, ch, v) for d in SETS for ch in CHS for v in VAR]
    with Pool(8) as pool: df = pd.DataFrame([r for r in pool.map(job, ps, chunksize=3) if r])
    df["方案"] = df.卖法 + " | " + df.通道
    for k in ["年化", "最大回撤", "夏普"]:
        print(f"== {k}"); print(df.pivot_table(index="方案", columns="数据", values=k).round(2).to_string()); print()
    seven = [k for k in SETS if "全程" not in k]
    print("== 7 组中位数"); print(df[df.数据.isin(seven)].groupby("方案")[["年化", "最大回撤", "夏普", "趋势次数"]].median().round(3).to_string())
    print("\n== BTC、ETH 各 1000U，2017-2026 组合")
    yrs = 9.12
    btc = {f"BTC {v[0]} | {ch}": curve("BTC全程", ch, v[1], v[2], v[3]) for ch in CHS for v in VAR if not (ch == "无通道" and v[3] > 0)}
    eth = {"ETH 单批+5% | 无通道": curve("ETH全程", "无通道", 0, .05, 0)}
    for ch in ["EMA32高低通道"]:
        eth[f"ETH 单批+5% | {ch}"] = curve("ETH全程", ch, 0, .05, 0)
        eth[f"ETH 整体+3%留50% | {ch}"] = curve("ETH全程", ch, 1, .03, .5)
    rows = []
    for bn, b in btc.items():
        for en, e in eth.items():
            n = min(len(b), len(e)); rows.append(dict(BTC=bn, ETH=en, **met(b[:n] + e[:n], yrs)))
    r = pd.DataFrame(rows).sort_values("夏普", ascending=False)
    print(r.head(15).round(3).to_string(index=False))
    print("-- 原方案"); print(r[(r.BTC == "BTC 整体+3% | 无通道") & (r.ETH == "ETH 单批+5% | 无通道")].round(3).to_string(index=False))
