import numpy as np
from engine import load
from engine2 import run_sched
LV = np.arange(1, 96) * 0.01; AM = np.full(95, 1000 / 95)
D = {s: load(f"data/{s}usdt_1m_2017_2026.npz") for s in ["btc", "eth"]}
yrs = len(D["btc"][4]) / 1440 / 365
for fee in (0.0, 0.00075, 0.001, 0.002):
    out = []
    for bs, es in [((1, .03), (0, .05)), ((1, .03), (1, .03))]:
        tot, fees_n = 0, 0
        for sym, (m, g) in (("btc", bs), ("eth", es)):
            ts, o, h, l, c = D[sym]; st, eq, cd = run_sched(o, h, l, c, LV, AM, g, m, fee, False)
            tot += st[0]; fees_n += st[3]
        out.append(f"利润 {tot:6.0f}U 不复投年化 {((2000+tot)/2000)**(1/yrs)-1:5.1%} 单利 {tot/2000/yrs:5.1%} 成交 {int(fees_n)} 笔")
    print(f"单边费率 {fee*100:.3f}% | BTC整体+3%/ETH单批+5%: {out[0]} | 两个整体+3%: {out[1]}")
