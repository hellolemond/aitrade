"""任意档位表引擎：档位 = 相对锚点的累计跌幅 levels[i]，每档金额 amts[i]。

空仓时锚点跟随价格上移；有持仓时锚点固定。
sell=0 单批止盈：后买先卖，每批涨 g 卖出，卖出后该档可再次买入。
sell=1 整体卖：价格 ≥ 持仓均价 × (1+g) 时全部卖出，锚点重置为当前价。
K 线内部路径同 engine.py。
"""
import numpy as np
from numba import njit

DAY = 1440


@njit(cache=True)
def run_sched(o, h, l, c, levels, amts, g, sell, fee, adverse):
    n = len(c)
    N = len(levels)
    cap = amts.sum()
    nd = n // DAY + 1
    eq_d = np.zeros(nd)
    cost_d = np.zeros(nd)
    lp = np.zeros(N)
    lq = np.zeros(N)
    m = 0
    qty = 0.0
    cost = 0.0
    cash = cap
    A = o[0]
    full_hits = 0
    worst_unreal = 0.0
    n_trade = 0
    pts = np.zeros(4)
    for i in range(n):
        if adverse or c[i] < o[i]:
            pts[0] = o[i]; pts[1] = h[i]; pts[2] = l[i]; pts[3] = c[i]
        else:
            pts[0] = o[i]; pts[1] = l[i]; pts[2] = h[i]; pts[3] = c[i]
        for t in range(4):
            p = pts[t]
            while True:
                acted = False
                if m == 0 and p > A:
                    A = p
                if m < N and p <= A * (1.0 - levels[m]):
                    bp = A * (1.0 - levels[m])
                    q = amts[m] * (1.0 - fee) / bp
                    lp[m] = bp; lq[m] = q
                    qty += q; cost += amts[m]; cash -= amts[m]
                    m += 1
                    n_trade += 1
                    if m == N:
                        full_hits += 1
                    acted = True
                elif m > 0:
                    if sell == 0:
                        sp = lp[m - 1] * (1.0 + g)
                        if p >= sp:
                            m -= 1
                            cash += lq[m] * sp * (1.0 - fee)
                            qty -= lq[m]; cost -= amts[m]
                            n_trade += 1
                            if m == 0:
                                qty = 0.0; cost = 0.0; A = p
                            acted = True
                    else:
                        sp = cost / qty * (1.0 + g)
                        if p >= sp:
                            cash += qty * sp * (1.0 - fee)
                            n_trade += 1
                            m = 0; qty = 0.0; cost = 0.0; A = p
                            acted = True
                if not acted:
                    break
            if m > 0:
                u = qty * p / cost - 1.0
                if u < worst_unreal:
                    worst_unreal = u
        if (i + 1) % DAY == 0 or i == n - 1:
            d = i // DAY
            eq_d[d] = cash + qty * c[i]
            cost_d[d] = cost
    stats = np.array([cash + qty * c[n - 1] - cap, full_hits, worst_unreal, n_trade, cost])
    return stats, eq_d, cost_d
