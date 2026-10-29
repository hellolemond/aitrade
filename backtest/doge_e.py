"""DOGE 套利版（E）详细回测：43,000 DOGE 起始，含强平检查（不同现货折算率）。"""
import json, urllib.request
import numpy as np, pandas as pd
from robust_eval import bars_1d
from futures_bt import read_zips, detrended, met
from hedge_liq import run_h
from repo_sys import trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
COINS = 43000

def doge_bars():
    b = bars_1d("DOGEUSDT")
    k = json.load(urllib.request.urlopen("https://data-api.binance.vision/api/v3/klines?symbol=DOGEUSDT&interval=1d&limit=60"))
    r = pd.DataFrame([[x[0], *map(float, x[1:5])] for x in k], columns=["t", "o", "h", "l", "c"]); r.index = pd.to_datetime(r.t, unit="ms")
    b = pd.concat([b, r[["o", "h", "l", "c"]]]); b = b[~b.index.duplicated(keep="last")].sort_index().iloc[:-1]
    f = read_zips("data/fut/DOGEUSDT-fundingRate-*.zip", [0, 2]); f.columns = ["t", "r"]
    b["fund"] = f.groupby(pd.to_datetime(f.t, unit="ms").dt.normalize()).r.sum().reindex(b.index).fillna(0.0003)
    return b

def stats(e, lab):
    y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0
    return dict(方案=lab, **met(e), 最差年=(y / p - 1).min())

if __name__ == "__main__":
    b = doge_bars(); start = "2020-07-15"; px0 = 0.07911
    print("数据", b.index[0].date(), "~", b.index[-1].date())

    print("\n== 1. 全周期（2020-07 ~ 2026-10，真实资金费）")
    rows = []
    for hair in (0.95, 0.8, 0.6, 0.5):
        e, info = run_h(b, start, w=0.0, hair=hair)
        rows.append(dict(**stats(e.dropna(), f"E 套利版 折算率{hair}"), 强平=info["套利强平"], 套利最差占用=info["套利最差亏损占可用保证金"]))
    e_a, _ = run_h(b, start, w=0.0, carry=False); rows.append(stats(e_a.dropna(), "A 基础版"))
    hold = b.c[start:] / b.c[start]; rows.append(stats(hold, "持币不动"))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    E, _ = run_h(b, start, w=0.0); E = E.dropna()
    print("\n== 2. 分年")
    yr = {}
    for lab, e in [("E 套利版", E), ("A 基础版", e_a.dropna()), ("持币不动", hold)]:
        y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0; yr[lab] = ((y / p - 1) * 100).round(1)
    yr["DOGE 年末价"] = b.c.groupby(b.index.year).last().round(4)
    print(pd.DataFrame(yr).to_string())

    print("\n== 3. 逐笔（按翻转统计）")
    st, up, lo = trend_state(b.h.values, b.l.values, b.c.values)
    s = pd.Series(st, index=b.index)[start:]
    print("翻转次数/年", round((s.diff() != 0).sum() / (len(s) / 365), 1), " 多头时间占比", round(s.mean(), 3))

    print(f"\n== 4. 运行 2 年的结果分布（起始 {COINS} DOGE ≈ {COINS * px0:,.0f}U）")
    rows = []
    for lab, bb in [("真实价格", b), ("去趋势 +30%/年", detrended(b, 0.3)), ("去趋势 0%", detrended(b, 0.0)), ("去趋势 -30%/年", detrended(b, -0.3))]:
        for name, kw in [("E 套利版", dict(w=0.0)), ("A 基础版", dict(w=0.0, carry=False))]:
            e = run_h(bb, start, **kw)[0].dropna(); w2 = (e.shift(-730) / e).dropna()
            rows.append(dict(价格=lab, 方案=name, 中位U=w2.median() * COINS * px0, P10U=w2.quantile(.1) * COINS * px0, P90U=w2.quantile(.9) * COINS * px0,
                             亏损概率=(w2 < 1).mean(), 期间最大回撤=met(e)["最大回撤"]))
        h = bb.c[start:] / bb.c[start]; w2 = (h.shift(-730) / h).dropna()
        rows.append(dict(价格=lab, 方案="持币不动", 中位U=w2.median() * COINS * px0, P10U=w2.quantile(.1) * COINS * px0, P90U=w2.quantile(.9) * COINS * px0,
                         亏损概率=(w2 < 1).mean(), 期间最大回撤=met(h)["最大回撤"]))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\n== 5. 当前")
    print(f"状态 {'多头' if st[-1] else '空头'}，收盘 {b.c.iloc[-1]:.5f}，上轨 {up[-1]:.5f}，下轨 {lo[-1]:.5f}")
