import numpy as np, pandas as pd
from trend import data, LV, AM, FEE
from engine3 import run_trend
def curve(ds, chn, sell, g, runner, use):
    o, h, l, c, day, ch = data(ds); up, ex = ch[chn]
    st, eq, cd = run_trend(o, h, l, c, day, up, ex, LV, AM, g, sell, FEE, use, runner); return eq
def met(e, yrs, name):
    pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    w = np.array([e[min(x + 365, len(e) - 1)] / e[x] - 1 for x in range(0, len(e) - 365, 30)])
    print(f"{name:42s} 年化 {(e[-1]/e[0])**(1/yrs)-1:6.1%} 回撤 {((e-pk)/pk).min():6.1%} 夏普 {r.mean()/r.std()*np.sqrt(365):.2f} 期末 {e[-1]:6.0f} 最差1年 {w.min():6.1%}")
yrs = 9.12
B = {"BTC 整体+3%": curve("BTC全程", "无通道", 1, .03, 0, False),
     "BTC 整体+3%留50%+布林": curve("BTC全程", "布林20,2σ", 1, .03, .5, False),
     "BTC 整体+3%留50%+回归50": curve("BTC全程", "线性回归50", 1, .03, .5, False)}
E = {"ETH 单批+5%": curve("ETH全程", "无通道", 0, .05, 0, False),
     "ETH 整体+3%留50%+布林": curve("ETH全程", "布林20,2σ", 1, .03, .5, False)}
for bn, b in B.items():
    for en, e in E.items():
        n = min(len(b), len(e)); x = b[:n] + e[:n]; x = x[x > 0]
        met(x, yrs, f"{bn} + {en}")
