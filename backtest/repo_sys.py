"""hellolemond/t 仓库的「币市交易系统」日线回测：EMA32 高低通道递归状态 + MACD 钝化结构。

忠实移植 src/lib/indicators.ts、structure.ts、ui/signalPanel.ts 的规则：
- 状态：多头时收盘 < EMA(low,32) 转空；空头时收盘 > EMA(high,32) 转多（首根默认多头）
- 仓位：多头 10 成、空头 0 成；反向结构动 3/4 成（日线 = 长周期 3 成，距趋势近 +1）
- 结构：摆动窗口 5、最小间隔 4、至少 2 根反向柱、影响期 100 根
信号在日线收盘产生，次日开盘按目标仓位调仓，手续费单边 0.1%。
"""
import numpy as np
import pandas as pd

FEE = 0.001
LEN = 32


def daily_bars(ts, o, h, l, c, ms=86_400_000):
    """按 UTC 对齐聚合 K 线，ms 为周期毫秒数（默认日线，4h = 14_400_000）。"""
    day = ts // ms
    df = pd.DataFrame({"d": day, "o": o, "h": h, "l": l, "c": c}).groupby("d").agg(
        o=("o", "first"), h=("h", "max"), l=("l", "min"), c=("c", "last"))
    return df


def ema(x, n):
    a = 2 / (n + 1)
    out = np.empty(len(x))
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def trend_state(h, l, c, n=LEN):
    up, lo = ema(h, n), ema(l, n)
    st = np.empty(len(c), dtype=np.int8)
    prev = 1
    for i in range(len(c)):
        s = (0 if c[i] < lo[i] else 1) if prev == 1 else (1 if c[i] > up[i] else 0)
        st[i] = s
        prev = s
    return st, up, lo


def swings(v, w, kind):
    out = []
    for i in range(w, len(v) - w):
        seg = v[i - w:i + w + 1]
        if (kind == "low" and v[i] <= seg.min()) or (kind == "high" and v[i] >= seg.max()):
            # 与 TS 一致：窗口内没有「更极端」的值（相等不算更极端）
            out.append(i)
    return out


def structures(h, l, c, w=5, max_age=100, gap=4, min_opp=2):
    """返回结构列表：(type, formed, invalidated or None)。"""
    dif = ema(c, 12) - ema(c, 26)
    hist = (dif - ema(dif, 9)) * 2
    out = []
    n = len(c)
    for typ in ("bottom", "top"):
        bot = typ == "bottom"
        p = l if bot else h
        sw = swings(p, w, "low" if bot else "high")
        for k in range(1, len(sw)):
            f, t = sw[k - 1], sw[k]
            if t - f < gap:
                continue
            if not ((p[t] < p[f]) if bot else (p[t] > p[f])):
                continue
            if not ((dif[t] > dif[f]) if bot else (dif[t] < dif[f])):
                continue
            opp = np.sum(hist[f:t + 1] < 0) if bot else np.sum(hist[f:t + 1] > 0)
            if opp < min_opp:
                continue
            front = dif[f]
            formed = inval = None
            for j in range(t + w + 1, n):
                gone = dif[j] < front if bot else dif[j] > front
                if formed is None:
                    if gone:
                        break
                    if (dif[j] > dif[j - 1]) if bot else (dif[j] < dif[j - 1]):
                        formed = j
                    continue
                if j - formed > max_age:
                    break
                if gone:
                    inval = j
                    break
            if formed is not None:
                out.append((typ, formed, inval))
    return out


def avg_range(h, l, c, i, lb=100):
    s = slice(max(0, i - lb + 1), i + 1)
    return np.mean((h[s] - l[s]) / c[s]) * 100


def target_weights(h, l, c, use_structure=True, long_interval=True):
    """每根 K 线收盘后的目标仓位（0~1）。long_interval：日线及以上结构 3 成起，否则 1 成起（signalPanel.ts）。"""
    st, up, lo = trend_state(h, l, c)
    n = len(c)
    tgt = st.astype(float)
    if not use_structure:
        return tgt, st
    S = structures(h, l, c)
    for i in range(n):
        # 当前有效结构：已形成、未纠错、在影响期内，取最近形成的
        act = None
        for typ, fm, inv in S:
            if fm > i or (inv is not None and inv <= i) or i - fm > 100:
                continue
            if act is None or fm > act[1]:
                act = (typ, fm, inv)
        if act is None:
            continue
        typ = act[0]
        bound = lo[i] if st[i] == 1 else up[i]
        dist = ((c[i] - bound) / bound if st[i] == 1 else (bound - c[i]) / bound) * 100
        near = dist / avg_range(h, l, c, i) < 1.5
        tenths = (3 if long_interval else 1) + (1 if near else 0)
        if st[i] == 1 and typ == "top":
            tgt[i] = 1 - tenths / 10
        elif st[i] == 0 and typ == "bottom":
            tgt[i] = tenths / 10
    return tgt, st


def run_weights(o, c, tgt, cap=1000.0, fee=FEE):
    """第 i 天收盘的目标仓位在第 i+1 天开盘执行。返回每日收盘权益。"""
    n = len(c)
    cash, qty = cap, 0.0
    eq = np.empty(n)
    trades = 0
    for i in range(n):
        if i > 1 and tgt[i - 1] == tgt[i - 2]:
            pass  # 目标不变不调仓
        elif i > 0:
            want = tgt[i - 1]
            val = cash + qty * o[i]
            cur = qty * o[i] / val if val > 0 else 0
            if abs(want - cur) > 1e-6:
                dv = want * val - qty * o[i]
                if dv > 0:
                    qty += dv * (1 - fee) / o[i]; cash -= dv
                else:
                    qty += dv / o[i]; cash += -dv * (1 - fee)
                trades += 1
        eq[i] = cash + qty * c[i]
    return eq, trades
