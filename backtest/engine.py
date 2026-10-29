"""下跌真实买入 + 上涨模拟做空卖出 的现货策略回测引擎。

K 线内部路径：阳线 O→L→H→C，阴线 O→H→L→C；adverse=True 时一律 O→H→L→C（先卖后买，偏保守）。
档位一律按档位价格成交（价格连续穿过档位）。
"""
import numpy as np
from numba import njit

DAY = 1440


@njit(cache=True)
def run_shadow(o, h, l, c, step, amt, cap, tp, first_ratio, parts, sstep,
               fee, min_notional, trail, adverse):
    """
    trail=0: 卖完后继续模拟空单，空单回到均价平仓后才重新以平仓价为锚点开始买入。
    trail=1: 卖完后立即回到买入模式，锚点跟随最高价。
    返回 (stats, daily_equity, daily_cost)
    """
    n = len(c)
    nd = n // DAY + 1
    eq_d = np.zeros(nd)
    cost_d = np.zeros(nd)

    cash = cap
    qty = 0.0
    cost = 0.0            # 当前持仓的买入成本（含手续费），用于均价
    mode = 0              # 0=买入模式(真实多) 1=模拟空单模式
    A = o[0]              # 买入锚点
    k = 0                 # 本锚点下已触及的买入档数
    P0 = 0.0              # 模拟空单首单价
    j = 0                 # 模拟空单已加档数
    unit = 0.0            # 每份卖出数量

    n_buy = 0
    n_sell = 0
    n_round = 0           # 清仓次数
    realized = 0.0
    max_cost = 0.0
    cap_hits = 0
    at_cap = False
    worst_unreal = 0.0    # 最大浮亏比例（相对持仓成本）
    fees = 0.0

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
                if mode == 0:
                    if qty <= 0.0 and k == 0 and p > A:
                        A = p
                    lvl = A * (1.0 - (k + 1) * step)
                    if p <= lvl:
                        k += 1
                        if cost + amt <= cap + 1e-9:
                            q = amt * (1.0 - fee) / lvl
                            qty += q
                            cost += amt
                            cash -= amt
                            fees += amt * fee
                            n_buy += 1
                            if cost > max_cost:
                                max_cost = cost
                            at_cap = False
                        elif not at_cap:
                            at_cap = True
                            cap_hits += 1
                        acted = True
                    elif qty > 0.0:
                        avg = cost / qty
                        trig = avg * (1.0 + tp)
                        if p >= trig:
                            # 首次卖出
                            sq = qty * first_ratio
                            if (qty - sq) * trig < min_notional:
                                sq = qty
                            proceeds = sq * trig * (1.0 - fee)
                            fees += sq * trig * fee
                            part_cost = cost * sq / qty
                            realized += proceeds - part_cost
                            cash += proceeds
                            cost -= part_cost
                            qty -= sq
                            n_sell += 1
                            if qty <= 1e-12:
                                qty = 0.0; cost = 0.0; n_round += 1
                            unit = qty / parts
                            mode = 1
                            P0 = trig
                            j = 0
                            acted = True
                elif trail and qty <= 0.0:
                    mode = 0; A = p; k = 0
                    acted = True
                else:
                    lvl = P0 * (1.0 + (j + 1) * sstep)
                    if p >= lvl:
                        j += 1
                        if qty > 0.0:
                            avg = cost / qty
                            if lvl >= avg * (1.0 + 0.003):
                                sq = unit
                                if sq > qty or (qty - sq) * lvl < min_notional:
                                    sq = qty
                                proceeds = sq * lvl * (1.0 - fee)
                                fees += sq * lvl * fee
                                part_cost = cost * sq / qty
                                realized += proceeds - part_cost
                                cash += proceeds
                                cost -= part_cost
                                qty -= sq
                                n_sell += 1
                                if qty <= 1e-12:
                                    qty = 0.0; cost = 0.0; n_round += 1
                        acted = True
                    else:
                        savg = P0 * (1.0 + j * sstep / 2.0)
                        if (j >= 1 and p <= savg) or (j == 0 and p <= P0 * (1.0 - step)):
                            mode = 0
                            A = savg if j >= 1 else P0
                            k = 0
                            acted = True
                if not acted:
                    break
            if qty > 0.0:
                u = qty * p / cost - 1.0
                if u < worst_unreal:
                    worst_unreal = u
        if (i + 1) % DAY == 0 or i == n - 1:
            d = i // DAY
            eq_d[d] = cash + qty * c[i]
            cost_d[d] = cost

    stats = np.array([cash + qty * c[n - 1] - cap, realized, n_buy, n_sell, n_round,
                      max_cost, cap_hits, worst_unreal, fees, qty, cost])
    return stats, eq_d, cost_d


@njit(cache=True)
def run_grid(o, h, l, c, step, amt, cap, g, fee, adverse):
    """经典抄底网格：每跌 step（相对最低未平仓批次）买一批，每批涨 g 单独卖出；空仓时锚点跟随最高价。"""
    n = len(c)
    nd = n // DAY + 1
    eq_d = np.zeros(nd)
    cost_d = np.zeros(nd)
    maxlots = int(cap / amt) + 1
    lp = np.zeros(maxlots)   # 批次买入价（栈）
    lq = np.zeros(maxlots)
    m = 0
    cash = cap
    A = o[0]
    realized = 0.0
    n_buy = 0
    n_sell = 0
    max_cost = 0.0
    fees = 0.0
    worst_unreal = 0.0
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
                ref = A if m == 0 else lp[m - 1]
                lvl = ref * (1.0 - step)
                if p <= lvl and (m + 1) * amt <= cap + 1e-9:
                    lp[m] = lvl
                    lq[m] = amt * (1.0 - fee) / lvl
                    m += 1
                    cash -= amt
                    fees += amt * fee
                    n_buy += 1
                    if m * amt > max_cost:
                        max_cost = m * amt
                    acted = True
                elif m > 0 and p >= lp[m - 1] * (1.0 + g):
                    sp = lp[m - 1] * (1.0 + g)
                    proceeds = lq[m - 1] * sp * (1.0 - fee)
                    fees += lq[m - 1] * sp * fee
                    realized += proceeds - amt
                    cash += proceeds
                    m -= 1
                    n_sell += 1
                    if m == 0:
                        A = p
                    acted = True
                if not acted:
                    break
            if m > 0:
                qty = 0.0
                for z in range(m):
                    qty += lq[z]
                u = qty * p / (m * amt) - 1.0
                if u < worst_unreal:
                    worst_unreal = u
        if (i + 1) % DAY == 0 or i == n - 1:
            d = i // DAY
            qty = 0.0
            for z in range(m):
                qty += lq[z]
            eq_d[d] = cash + qty * c[i]
            cost_d[d] = m * amt
    qty = 0.0
    for z in range(m):
        qty += lq[z]
    stats = np.array([cash + qty * c[n - 1] - cap, realized, n_buy, n_sell, 0,
                      max_cost, 0, worst_unreal, fees, qty, m * amt])
    return stats, eq_d, cost_d


def load(path="data/btcusdt_1m.npz"):
    d = np.load(path)
    return d["ts"], d["open"], d["high"], d["low"], d["close"]


def summarize(stats, eq_d, cost_d, cap, years):
    eq = eq_d[eq_d > 0]
    peak = np.maximum.accumulate(eq)
    mdd = ((eq - peak) / peak).min()
    return {
        "总收益U": stats[0],
        "已实现U": stats[1],
        "年化(按cap)": (1 + stats[0] / cap) ** (1 / years) - 1,
        "最大回撤": mdd,
        "最大浮亏(持仓)": stats[7],
        "峰值占用U": stats[5],
        "平均占用": cost_d.mean() / cap,
        "买入次数": int(stats[2]),
        "卖出次数": int(stats[3]),
        "清仓轮数": int(stats[4]),
        "触顶次数": int(stats[6]),
        "手续费U": stats[8],
        "期末持仓成本U": stats[10],
    }
