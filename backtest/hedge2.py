"""对冲方案对比。日频权重模型：第 i 日收盘后决定权重，按 i+1 日开盘到 i+2 日开盘的收益计。

子账户（每个币各自一套）：
- 现货：state=1 持币，否则持 USDT；carry=True 时空头期改为「现货 + 1x 合约空单」收资金费
- 空单：过滤条件成立时 1x 做空，收/付资金费
组合按 (1-w):w 每年初再平衡，BTC/ETH 各半。手续费：现货 0.1%、合约 0.05%（按权重变化量计）。
"""
import numpy as np, pandas as pd
from futures_bt import spot_bars, met, detrended
from repo_sys import trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
SPOT_FEE, FUT_FEE = 0.001, 0.0005


def weekly_state(b):
    """币安周线（周一 00:00 UTC 开）收盘后的 EMA32 状态，映射到下一周每天（无前视）。"""
    w = b.resample("W-SUN").agg({"h": "max", "l": "min", "c": "last"})
    st, _, _ = trend_state(w.h.values, w.l.values, w.c.values)
    s = pd.Series(st, index=w.index)            # 周日收盘时已知
    return s.reindex(b.index, method="ffill").fillna(1).values


def sleeves(b, start):
    O, H, L, C, F = (b[k].values for k in ["o", "h", "l", "c", "fund"])
    st, _, _ = trend_state(H, L, C)
    wk = weekly_state(b)
    sma200 = pd.Series(C).rolling(200).mean().values
    r = np.r_[O[1:] / O[:-1] - 1, 0.0]           # 第 i 日开盘 → i+1 日开盘
    vol = pd.Series(np.log(C[1:] / C[:-1])).rolling(30).std().values * np.sqrt(365)
    vol = np.r_[np.nan, vol]
    n = len(C); i0 = int(np.searchsorted(b.index, pd.Timestamp(start)))

    def sim(w_long, w_short, carry=False):
        """w_*[i]：第 i 日收盘决定、第 i+1 日开盘生效的权重。"""
        eq = np.ones(n); pl = ps = 0.0; ph = 0.0
        for i in range(i0 + 1, n - 1):
            nl, ns = w_long[i - 1], w_short[i - 1]
            nh = (1 - nl) if carry else 0.0       # 套利腿：现货 + 等量合约空单
            cost = abs(nl + nh - pl - ph) * SPOT_FEE + abs(ns - ps) * FUT_FEE + abs(nh - ph) * FUT_FEE
            g = nl * r[i] - ns * r[i] + (ns + nh) * F[i]   # 套利腿价格涨跌对冲为 0，只收资金费
            eq[i] = eq[i - 1] * (1 + g - cost); pl, ps, ph = nl, ns, nh
        e = pd.Series(eq[i0:n - 1], index=b.index[i0:n - 1]); return e / e.iloc[0]

    long1 = (st == 1).astype(float)
    tv = np.clip(0.6 / np.where(np.isnan(vol), 0.6, vol), 0, 1)  # 目标年化波动 60%
    S = {
        "现货": sim(long1, 0 * long1),
        "现货+空头期套利": sim(long1, 0 * long1, carry=True),
        "现货 波动控制": sim(long1 * tv, 0 * long1),
        "空单 日线": sim(0 * long1, (st == 0).astype(float)),
        "空单 日线+周线": sim(0 * long1, ((st == 0) & (wk == 0)).astype(float)),
        "空单 日线+200日线下": sim(0 * long1, ((st == 0) & (C < np.nan_to_num(sma200, nan=np.inf))).astype(float)),
        "现金": pd.Series(1.0, index=b.index[i0:n - 1]),
    }
    return S


def combo(parts, w):
    """parts: [(主仓曲线, 对冲曲线)]，每币各半；每年初把主:对冲拉回 (1-w):w。"""
    tot = 0
    for main, hedge in parts:
        idx = main.index; per = idx.year; a, h = 0.5 * (1 - w), 0.5 * w; v = []
        m, hg = main.values, hedge.reindex(idx).values
        for i in range(len(idx)):
            if i > 0:
                a *= m[i] / m[i - 1]; h *= hg[i] / hg[i - 1]
                if per[i] != per[i - 1]: t = a + h; a, h = t * (1 - w), t * w
            v.append(a + h)
        tot = tot + pd.Series(v, index=idx)
    return tot


PLANS = [
    ("A 现货基准", "现货", "现金", 0.0),
    ("B 30%日线做空", "现货", "空单 日线", 0.3),
    ("C 30%做空+周线过滤", "现货", "空单 日线+周线", 0.3),
    ("D 30%做空+200日线过滤", "现货", "空单 日线+200日线下", 0.3),
    ("E 空头期期现套利", "现货+空头期套利", "现金", 0.0),
    ("F 波动控制", "现货 波动控制", "现金", 0.0),
    ("G 套利+30%周线过滤做空", "现货+空头期套利", "空单 日线+周线", 0.3),
    ("H 套利+30%日线做空", "现货+空头期套利", "空单 日线", 0.3),
]

if __name__ == "__main__":
    SB = {s: spot_bars(s) for s in ["BTC", "ETH"]}
    rows = []
    for lab, bars, start in [("2017-10~2026-09", SB, "2017-10-17"), ("2020-01~2026-09", SB, "2020-01-01"),
                             ("去趋势 0%", {s: detrended(b, 0.0) for s, b in SB.items()}, "2017-10-17"),
                             ("去趋势 -20%", {s: detrended(b, -0.2) for s, b in SB.items()}, "2017-10-17")]:
        SL = {s: sleeves(b, start) for s, b in bars.items()}
        for name, m, h, w in PLANS:
            e = combo([(SL[s][m], SL[s][h]) for s in SL], w)
            y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0; g = y / p - 1
            rows.append(dict(区间=lab, 方案=name, **met(e), 最差年=g.min(), 年2018=g.get(2018, np.nan), 年2022=g.get(2022, np.nan)))
    df = pd.DataFrame(rows)
    for lab, g in df.groupby("区间", sort=False):
        print(f"\n== {lab}"); print(g.drop(columns="区间").round(3).to_string(index=False))
    print("\n== 空头期资金费年化（2020 起，状态为空头的日子）")
    for s, b in SB.items():
        st, _, _ = trend_state(b.h.values, b.l.values, b.c.values); f = b.fund["2020":]; m = st[-len(f):] == 0
        print(s, f"空头期 {f[m].mean() * 365:.1%}，多头期 {f[~m].mean() * 365:.1%}")
