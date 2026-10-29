import numpy as np, pandas as pd
from engine import load, run_shadow, run_grid, summarize
pd.set_option("display.width", 250)
ts, o, h, l, c = load(); CAP=1000.; FEE=0.001; YRS=len(c)/1440/365
days = pd.to_datetime(ts[::1440], unit="ms")
cands = {
 "A 原方案 0.5%/10U tp5% trail": ("s", 0.005, 10., 0.05, 1),
 "B 0.5%/10U tp2% 等空单平仓": ("s", 0.005, 10., 0.02, 0),
 "C 1%/12.5U tp5% trail": ("s", 0.01, 12.5, 0.05, 1),
 "D 1%/12.5U tp2% 等空单平仓": ("s", 0.01, 12.5, 0.02, 0),
 "E 网格 1%/12.5U 每批+5%": ("g", 0.01, 12.5, 0.05, 0),
}
rows=[]; yr={}
for name,(k,step,amt,tp,trail) in cands.items():
    for adv in (False, True):
        if k=="s": st,eq,cd = run_shadow(o,h,l,c,step,amt,CAP,tp,0.3,5.,step,FEE,5.,trail,adv)
        else: st,eq,cd = run_grid(o,h,l,c,step,amt,CAP,tp,FEE,adv)
        r = summarize(st,eq,cd,CAP,YRS); r["方案"]=name+(" [保守路径]" if adv else ""); rows.append(r)
        if not adv:
            s = pd.Series(eq[:len(days)], index=days[:len(eq)]); s=s[s>0]
            ye = s.groupby(s.index.year).last(); prev = np.r_[CAP, ye.values[:-1]]
            yr[name] = pd.Series(ye.values-prev, index=ye.index)
df = pd.DataFrame(rows).set_index("方案")
print(df[["总收益U","年化(按cap)","最大回撤","最大浮亏(持仓)","平均占用","买入次数","卖出次数","手续费U","触顶次数"]].round(3).to_string())
yd = pd.DataFrame(yr)
yd["BTC涨跌"] = pd.Series(c[:len(days)*1440:1440][:len(days)], index=days).groupby(days.year).agg(lambda x: x.iloc[-1]/x.iloc[0]-1)
print("\n逐年盈亏(U, 含浮盈浮亏)"); print(yd.round(1).to_string())
