"""趋势通道做 U 本位永续合约：收盘站上上轨开多、跌破下轨开空（翻转即平仓反手），始终在场。

- 信号：日线 EMA32 高低通道递归状态（与现货方案相同），次日开盘成交
- 每笔开仓名义 = 当时权益 × 杠杆，持仓数量固定到下次翻转（逐仓、全部资金作保证金）
- 手续费：吃单 0.05%/边；资金费率：2020 起用币安真实值，2017-2019 段假设每 8h 0.01%
- 爆仓：日内最高/最低触及强平价（维持保证金 0.5%）即权益归零
"""
import glob, zipfile
import numpy as np, pandas as pd
from engine import load
from repo_sys import daily_bars, trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
FEE, MM = 0.0005, 0.005


def read_zips(pat, cols):
    fr = []
    for p in sorted(glob.glob(pat)):
        with zipfile.ZipFile(p) as z, z.open(z.namelist()[0]) as f:
            d = pd.read_csv(f, header=None)
            if not str(d.iloc[0, 0]).lstrip("-").isdigit(): d = d.iloc[1:]
            fr.append(d.iloc[:, cols].astype(float))
    return pd.concat(fr)


def fut_bars(sym):
    d = read_zips(f"data/fut/{sym}-1d-*.zip", [0, 1, 2, 3, 4]); d.columns = ["t", "o", "h", "l", "c"]
    d = d.drop_duplicates("t").sort_values("t"); d.index = pd.to_datetime(d.t, unit="ms").dt.normalize()
    f = read_zips(f"data/fut/{sym}-fundingRate-*.zip", [0, 2]); f.columns = ["t", "r"]
    fd = f.groupby(pd.to_datetime(f.t, unit="ms").dt.normalize()).r.sum()
    d = d[["o", "h", "l", "c"]].reindex(pd.date_range(d.index[0], d.index[-1])).ffill()
    d["fund"] = fd.reindex(d.index).fillna(0.0003)
    return d


def spot_bars(sym):
    ts, o, h, l, c = load(f"data/{sym.lower()}usdt_1m_2017_2026.npz"); b = daily_bars(ts, o, h, l, c)
    b = b.reindex(range(b.index[0], b.index[-1] + 1)).ffill(); b.index = pd.to_datetime(b.index.values * 86_400_000, unit="ms")
    fd = pd.concat([fut_bars(f"{sym}USDT").fund for _ in [0]])
    b["fund"] = fd.reindex(b.index).fillna(0.0003)   # 2020 前无合约数据，按 0.01%/8h
    return b


def run(b, lev=1.0, mode="双向", warm=None):
    """mode: 双向 / 只多 / 只空。warm: 指标用全部历史，从该日起交易。返回 (日权益, 交易表, 爆仓次数)。"""
    O, H, L, C, F = (b[k].values for k in ["o", "h", "l", "c", "fund"])
    st, _, _ = trend_state(H, L, C); n = len(C); idx = b.index
    i0 = 0 if warm is None else int(np.searchsorted(idx, pd.Timestamp(warm)))
    eq = 1.0; side = 0; qty = ent = margin = 0.0; liq = 0
    out = np.full(n, np.nan); trades = []
    want_of = lambda s: (1 if s == 1 else -1) if mode == "双向" else ((1 if s == 1 else 0) if mode == "只多" else (-1 if s == 0 else 0))
    for i in range(i0 + 1, n):
        want = want_of(st[i - 1]) if eq > 0 else 0
        if want != side:
            if side != 0:                                      # 平仓
                pnl = side * qty * (O[i] - ent); eq = margin + pnl - qty * O[i] * FEE
                trades.append((side, ent, O[i], eq / margin - 1)); side = 0
            if want != 0 and eq > 0:                           # 开仓
                qty = eq * lev / O[i]; eq -= qty * O[i] * FEE; ent = O[i]; margin = eq; side = want
        if side != 0:
            liq_px = ent * (1 - 1 / lev + MM) if side == 1 else ent * (1 + 1 / lev - MM)
            if (side == 1 and L[i] <= liq_px) or (side == -1 and H[i] >= liq_px):
                trades.append((side, ent, liq_px, -1.0)); liq += 1; eq = 0.0; margin = 0.0; side = 0; qty = 0
            else:
                margin -= side * qty * C[i] * F[i]               # 资金费：多头付正费率
                eq = margin + side * qty * (C[i] - ent)
        out[i] = max(eq, 0.0)
    e = pd.Series(out, index=idx).dropna()
    return e, pd.DataFrame(trades, columns=["方向", "开仓价", "平仓价", "收益"]), liq


def met(e):
    v = e.values; yrs = len(v) / 365
    if v[-1] <= 0: return dict(年化=-1.0, 最大回撤=-1.0, 夏普=np.nan, 期末倍数=0.0)
    pk = np.maximum.accumulate(v); r = np.diff(v) / v[:-1]
    return dict(年化=(v[-1] / v[0]) ** (1 / yrs) - 1, 最大回撤=((v - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365), 期末倍数=v[-1] / v[0])


def detrended(b, drift=0.0):
    C = b.c.values; t = np.arange(len(C)); mu = np.log(C[-1] / C[0]) / (len(C) - 1)
    f = np.exp((np.log(1 + drift) / 365 - mu) * t); d = b.copy()
    for k in "ohlc": d[k] = d[k].values * f
    return d


if __name__ == "__main__":
    # 信号、成交、强平都用现货价格（近似标记价格），资金费 2020 起用真实值
    SB = {s: spot_bars(s) for s in ["BTC", "ETH"]}
    for s in SB: print(f"{s} 资金费率年化均值（2020 起，多头支付）: {SB[s].fund['2020':].mean() * 365:.1%}")
    MODES = [("只多", 1), ("双向", 1), ("双向", 2), ("双向", 3), ("只空", 1)]
    for lab, warm in [("2020-01 ~ 2026-09（真实资金费）", "2020-01-01"), ("2017-10 ~ 2026-09", "2017-10-17")]:
        print(f"\n== {lab}，指标从 2017-08 开始推演")
        rows = []
        for s, b in SB.items():
            for mode, lev in MODES:
                e, t, lq = run(b, lev, mode, warm=warm); sh = t[t.方向 == -1]
                rows.append(dict(币=s, 方式=mode, 杠杆=lev, **met(e), 爆仓=lq, 笔数=len(t),
                                 空单胜率=(sh.收益 > 0).mean() if len(sh) else np.nan, 空单累计=np.prod(1 + sh.收益) - 1 if len(sh) else np.nan))
        for mode, lev in MODES[:4]:
            e = (run(SB["BTC"], lev, mode, warm=warm)[0] + run(SB["ETH"], lev, mode, warm=warm)[0]) / 2
            rows.append(dict(币="各半", 方式=mode, 杠杆=lev, **met(e.dropna())))
        print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\n== 分年（1 倍，2017-10 起）")
    yr = {}
    for s, b in SB.items():
        for mode in ["只多", "双向", "只空"]:
            e = run(b, 1, mode, warm="2017-10-17")[0]; y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0
            yr[f"{s} {mode}"] = (y / p - 1) * 100
    print(pd.DataFrame(yr).round(1).to_string())

    print("\n== 剔除牛市：去趋势价格（长期年化 0% / -20%）")
    rows = []
    for s, b in SB.items():
        for d in (0.0, -0.2):
            db = detrended(b, d)
            for mode, lev in [("只多", 1), ("双向", 1), ("双向", 2), ("只空", 1)]:
                e, t, lq = run(db, lev, mode, warm="2017-10-17"); rows.append(dict(币=s, 长期年化=f"{d:+.0%}", 方式=mode, 杠杆=lev, **met(e), 爆仓=lq))
    print(pd.DataFrame(rows).round(3).to_string(index=False))
