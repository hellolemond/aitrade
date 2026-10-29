import numpy as np, pandas as pd
from trend import SETS, data
pd.set_option("display.width", 250)
df = pd.read_csv("trend.csv")
rows = []
for ds in SETS:
    o, h, l, c, day, ch = data(ds); px = pd.Series(c).groupby(day).last().values; yrs = len(c) / 1440 / 365
    for wgt in (0.2, 0.3, 0.5, 1.0):
        e = [1000.]
        for i in range(1, len(px)): e.append(e[-1] * (wgt * px[i] / px[i - 1] + 1 - wgt))
        e = np.array(e); pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
        rows.append(dict(数据=ds, 通道="-", 卖法=f"固定{int(wgt*100)}%", 年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365)))
df = pd.concat([df, pd.DataFrame(rows)])
df["方案"] = df.卖法 + " " + df.通道
keep = ["整体+3% 无通道", "单批+5% 无通道", "单批+5% 唐奇安20/10", "整体+3%留50% 唐奇安20/10", "整体+3%留50% 肯特纳EMA20±2ATR", "整体+3%留50% 布林20,2σ", "固定20% -", "固定30% -", "固定50% -", "固定100% -"]
d = df[df.方案.isin(keep)]
for k in ["年化", "最大回撤", "夏普"]:
    print(f"== {k}"); print(d.pivot_table(index="方案", columns="数据", values=k).reindex(keep).round(2).to_string()); print()
seven = [k for k in SETS if "全程" not in k]
print("== 7 组中位数"); print(d[d.数据.isin(seven)].groupby("方案")[["年化", "最大回撤", "夏普"]].median().reindex(keep).round(3).to_string())
