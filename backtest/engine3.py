"""网格 + 日线趋势通道。

在 engine2.run_sched 基础上：
- 日内价格 ≥ 上轨（用截至前一日的数据计算）且有持仓时进入趋势模式，暂停止盈卖出。
- 日线收盘 < 离场线时退出趋势模式：卖出盈利部分（价格 ≥ 成本×1.002），其余回到普通网格。
- runner>0（仅整体卖）：止盈时只卖 1-runner，剩余作为趋势仓，收盘跌破离场线时卖出（不论是否在通道上方）。
"""
import numpy as np
from numba import njit


@njit(cache=True)
def run_trend(o, h, l, c, dayid, up_prev, exit_line, levels, amts, g, sell, fee, use_trend, runner):
    n = len(c)
    N = len(levels)
    cap = amts.sum()
    nd = dayid[-1] + 1
    eq_d = np.zeros(nd)
    cost_d = np.zeros(nd)
    lp = np.zeros(N)
    lq = np.zeros(N)
    m = 0
    qty = 0.0
    cost = 0.0
    cash = cap
    A = o[0]
    trend = False
    rq = 0.0          # 趋势仓数量
    rc = 0.0          # 趋势仓成本
    worst_unreal = 0.0
    n_trade = 0
    n_trend = 0
    pts = np.zeros(4)
    for i in range(n):
        d = dayid[i]
        if c[i] < o[i]:
            pts[0] = o[i]; pts[1] = h[i]; pts[2] = l[i]; pts[3] = c[i]
        else:
            pts[0] = o[i]; pts[1] = l[i]; pts[2] = h[i]; pts[3] = c[i]
        up = up_prev[d]
        for t in range(4):
            p = pts[t]
            if use_trend and not trend and m > 0 and up == up and p >= up:
                trend = True
                n_trend += 1
            while True:
                acted = False
                if m == 0 and p > A:
                    A = p
                if m < N and p <= A * (1.0 - levels[m]) and cash >= amts[m] - 1e-9:
                    bp = A * (1.0 - levels[m])
                    q = amts[m] * (1.0 - fee) / bp
                    lp[m] = bp; lq[m] = q
                    qty += q; cost += amts[m]; cash -= amts[m]
                    m += 1
                    n_trade += 1
                    acted = True
                elif m > 0 and not trend:
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
                            sq = qty * (1.0 - runner)
                            cash += sq * sp * (1.0 - fee)
                            if runner > 0.0:
                                rq += qty - sq
                                rc += cost * runner
                            n_trade += 1
                            m = 0; qty = 0.0; cost = 0.0; A = p
                            acted = True
                if not acted:
                    break
            if m > 0:
                u = qty * p / cost - 1.0
                if u < worst_unreal:
                    worst_unreal = u
        # 日线收盘
        if i == n - 1 or dayid[i + 1] != d:
            cl = c[i]
            ex = exit_line[d]
            if ex == ex and cl < ex:
                if trend:
                    trend = False
                    if sell == 0:
                        while m > 0 and cl >= lp[m - 1] * 1.002:
                            m -= 1
                            cash += lq[m] * cl * (1.0 - fee)
                            qty -= lq[m]; cost -= amts[m]
                            n_trade += 1
                        if m == 0:
                            qty = 0.0; cost = 0.0; A = cl
                    elif m > 0 and cl >= cost / qty * 1.002:
                        cash += qty * cl * (1.0 - fee)
                        n_trade += 1
                        m = 0; qty = 0.0; cost = 0.0; A = cl
                if rq > 0.0:
                    cash += rq * cl * (1.0 - fee)
                    n_trade += 1
                    rq = 0.0; rc = 0.0
            eq_d[d] = cash + (qty + rq) * cl
            cost_d[d] = cost + rc
    stats = np.array([cash + (qty + rq) * c[n - 1] - cap, n_trend, worst_unreal, n_trade, cost + rc])
    return stats, eq_d, cost_d
