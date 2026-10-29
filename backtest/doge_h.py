import json, urllib.request, glob, zipfile
import numpy as np, pandas as pd
from robust_eval import bars_1d
from futures_bt import read_zips, detrended, met
from hedge_liq import run_h
from repo_sys import trend_state
pd.set_option("display.width", 250)
b = bars_1d("DOGEUSDT")
k = json.load(urllib.request.urlopen("https://data-api.binance.vision/api/v3/klines?symbol=DOGEUSDT&interval=1d&limit=60"))
r = pd.DataFrame([[x[0], *map(float, x[1:5])] for x in k], columns=["t", "o", "h", "l", "c"])
r.index = pd.to_datetime(r.t, unit="ms"); b = pd.concat([b, r[["o", "h", "l", "c"]]]); b = b[~b.index.duplicated(keep="last")].sort_index()
b = b.iloc[:-1]                                                  # 去掉未收盘的今天
f = read_zips("data/fut/DOGEUSDT-fundingRate-*.zip", [0, 2]); f.columns = ["t", "r"]
fd = f.groupby(pd.to_datetime(f.t, unit="ms").dt.normalize()).r.sum()
b["fund"] = fd.reindex(b.index).fillna(0.0003)
print("数据", b.index[0].date(), "~", b.index[-1].date(), "最新收盘", b.c.iloc[-1])
st, up, lo = trend_state(b.h.values, b.l.values, b.c.values)
print(f"当前状态: {'多头' if st[-1] else '空头'}  上轨 {up[-1]:.5f} 下轨 {lo[-1]:.5f}  资金费年化均值 {fd.mean()*365*3/3:.1%}" if False else f"当前状态: {'多头' if st[-1] else '空头'}  上轨 {up[-1]:.5f}  下轨 {lo[-1]:.5f}")
print(f"DOGE 资金费年化均值 {fd.mean() * 365:.1%}")
start = "2020-07-15"
scen = {"真实价格": b, "去趋势0%": detrended(b, 0.0), "去趋势-30%": detrended(b, -0.3)}
rows = []; W = 730
for lab, bb in scen.items():
    for name, kw in [("A 基础版", dict(w=0.0, carry=False)), ("E 套利版", dict(w=0.0)), ("H 对冲版", dict(w=0.3))]:
        e, info = run_h(bb, start, **kw); e = e.dropna()
        w2 = (e.shift(-W) / e).dropna()
        rows.append(dict(价格=lab, 方案=name, **met(e), 强平=info["套利强平"] + info["空单强平"], 空单最差=info["空单最差亏损占保证金"],
                         两年中位倍数=w2.median(), 两年P10=w2.quantile(.1), 两年P90=w2.quantile(.9), 两年最差=w2.min(), 两年亏损概率=(w2 < 1).mean()))
    hold = (bb.c[start:] / bb.c[start]); w2 = (hold.shift(-W) / hold).dropna()
    rows.append(dict(价格=lab, 方案="持币不动", **met(hold), 两年中位倍数=w2.median(), 两年P10=w2.quantile(.1), 两年P90=w2.quantile(.9), 两年最差=w2.min(), 两年亏损概率=(w2 < 1).mean()))
print(pd.DataFrame(rows).round(3).to_string(index=False))
# 空单持有期最大不利涨幅
O, H, L, C = (b[k].values for k in "ohlc"); mae = []; i = 1
while i < len(C):
    if st[i - 1] == 0:
        ent = O[i]; j = i; hi = H[i]
        while j < len(C) and st[j - 1] == 0: hi = max(hi, H[j]); j += 1
        mae.append((b.index[i].date(), hi / ent - 1)); i = j
    else: i += 1
print("空单持有期最大不利涨幅 top5:", sorted(mae, key=lambda x: -x[1])[:5])
