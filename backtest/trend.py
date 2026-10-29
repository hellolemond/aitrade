"""网格 + 日线趋势通道，7 组数据集 + 2017-2026 BTC/ETH 组合。"""
import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from engine3 import run_trend
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)
CAP, FEE = 1000., 0.001
LV = np.arange(1, 96) * 0.01; AM = np.full(95, CAP / 95)
SETS = {f"{s[:3]}样本内": f"data/{s.lower()}_1m.npz" for s in ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]}
SETS.update({f"{s[:3]}样本外": f"data/{s.lower()}_1m_2017_2019.npz" for s in ["BTCUSDT", "ETHUSDT", "BNBUSDT"]})
SETS.update({"BTC全程": "data/btcusdt_1m_2017_2026.npz", "ETH全程": "data/ethusdt_1m_2017_2026.npz"})

def channels(ts, h, l, c):
    day = (ts // 86_400_000).astype(np.int64); day = day - day[0]
    df = pd.DataFrame({"d": day, "h": h, "l": l, "c": c}).groupby("d").agg(h=("h", "max"), l=("l", "min"), c=("c", "last"))
    df = df.reindex(range(day[-1] + 1)).ffill()
    H, L, C = df.h, df.l, df.c
    out = {"无通道": (np.full(len(df), np.nan), np.full(len(df), np.nan))}
    out["唐奇安20/10"] = (H.rolling(20).max().shift(1).values, L.rolling(10).min().shift(1).values)
    ma, sd = C.rolling(20).mean(), C.rolling(20).std()
    out["布林20,2σ"] = ((ma + 2 * sd).shift(1).values, ma.values)
    ema = C.ewm(span=20, adjust=False).mean()
    tr = pd.concat([H - L, (H - C.shift()).abs(), (L - C.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(span=14, adjust=False).mean()
    out["肯特纳EMA20±2ATR"] = ((ema + 2 * atr).shift(1).values, ema.values)
    eh, el, ec = H.ewm(span=32, adjust=False).mean(), L.ewm(span=32, adjust=False).mean(), C.ewm(span=32, adjust=False).mean()
    out["EMA32高低通道"] = (eh.shift(1).values, el.values)
    out["EMA32收盘"] = (ec.shift(1).values, ec.values)
    x = np.arange(50); mid = np.full(len(C), np.nan); upb = np.full(len(C), np.nan); cv = C.values
    for i in range(49, len(cv)):
        y = cv[i - 49:i + 1]; b, a = np.polyfit(x, y, 1); fit = a + b * x
        mid[i] = fit[-1]; upb[i] = fit[-1] + 2 * (y - fit).std()
    out["线性回归50"] = (np.r_[np.nan, upb[:-1]], mid)
    return day.astype(np.int64), out

_cache = {}
def data(k):
    if k not in _cache:
        ts, o, h, l, c = load(SETS[k]); day, ch = channels(ts, h, l, c); _cache[k] = (o, h, l, c, day, ch)
    return _cache[k]

VARIANTS = [("单批+5%", 0, 0.05, 0.0), ("整体+3%", 1, 0.03, 0.0), ("整体+3%留50%", 1, 0.03, 0.5)]

def job(p):
    ds, chn, (vn, sell, g, runner) = p
    o, h, l, c, day, ch = data(ds); up, ex = ch[chn]
    use = chn != "无通道"
    if runner > 0 and not use: return None
    st, eq, cd = run_trend(o, h, l, c, day, up, ex, LV, AM, g, sell, FEE, use and runner == 0, runner)
    e = eq[eq > 0]; yrs = len(c) / 1440 / 365
    pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    # 年度窗口（连续曲线上的滚动 1 年）
    w = np.array([e[min(x + 365, len(e) - 1)] / e[x] - 1 for x in range(0, len(e) - 365, 30)])
    return dict(数据=ds, 通道=chn, 卖法=vn, 年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(),
                夏普=r.mean() / r.std() * np.sqrt(365), 趋势次数=int(st[1]), 平均占用=cd.mean() / CAP, 窗口P10=np.percentile(w, 10), 窗口最差=w.min())

if __name__ == "__main__":
    chs = ["无通道", "唐奇安20/10", "布林20,2σ", "肯特纳EMA20±2ATR", "线性回归50"]
    ps = [(d, ch, v) for d in SETS for ch in chs for v in VARIANTS]
    with Pool(8) as pool: rows = [r for r in pool.map(job, ps, chunksize=3) if r]
    df = pd.DataFrame(rows); df.to_csv("trend.csv", index=False)
    seven = [k for k in SETS if "全程" not in k]
    print("== 7 组数据平均")
    print(df[df.数据.isin(seven)].groupby(["卖法", "通道"])[["年化", "最大回撤", "夏普", "窗口P10", "窗口最差", "趋势次数", "平均占用"]].mean().round(3).to_string())
    print("\n== 相对无通道的年化提升，按数据集（同卖法）")
    piv = df.pivot_table(index=["卖法", "通道"], columns="数据", values="年化")
    for vn in ["单批+5%", "整体+3%"]:
        base = piv.loc[(vn, "无通道")]
        print(f"-- {vn}"); print((piv.loc[vn] - base).round(3).to_string())
    print("-- 整体+3%留50% 相对 整体+3%无通道"); print((piv.loc["整体+3%留50%"] - piv.loc[("整体+3%", "无通道")]).round(3).to_string())
    print("\n== 2017-2026 全程")
    print(df[df.数据.str.contains("全程")].sort_values(["数据", "卖法", "通道"]).round(3).to_string(index=False))
