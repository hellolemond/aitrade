"""结构信号的作用拆解：触发次数、调整仓位的天数、每段的盈亏。"""
import numpy as np, pandas as pd
from engine import load
from repo_sys import daily_bars, target_weights, structures, trend_state
from repo_bt import SETS
pd.set_option("display.width", 250)
rows = []
for ds in ["BTC全程", "ETH全程", "BNB样本内", "SOL样本内", "BNB样本外"]:
    ts, o, h, l, c = load(SETS[ds])
    db = daily_bars(ts, o, h, l, c); db = db.reindex(range(db.index[0], db.index[-1] + 1)).ffill()
    O, H, L, C = (db[k].values for k in "ohlc")
    t1, st = target_weights(H, L, C, False); t2, _ = target_weights(H, L, C, True)
    S = structures(H, L, C)
    delta = t2 - t1                       # 结构带来的仓位偏离（正=趋势下抄底，负=趋势上减仓）
    # 偏离持仓在次日开盘执行，收益按开盘到开盘
    r = np.r_[O[1:] / O[:-1] - 1, 0]
    eps = []; i = 0; n = len(C)
    while i < n - 1:
        if delta[i] != 0:
            j = i; pnl = 1.0
            while j < n - 1 and delta[j] != 0 and np.sign(delta[j]) == np.sign(delta[i]):
                pnl *= 1 + r[j + 1] * np.sign(delta[i]) if j + 1 < n else 1
                j += 1
            eps.append(("底部买入" if delta[i] > 0 else "顶部减仓", j - i, pnl - 1))
            i = j
        else:
            i += 1
    e = pd.DataFrame(eps, columns=["类型", "天数", "方向收益"])
    for typ, g in e.groupby("类型"):
        rows.append(dict(数据=ds, 类型=typ, 次数=len(g), 平均持续天=g.天数.mean(), 胜率=(g.方向收益 > 0).mean(), 平均方向收益=g.方向收益.mean(), 中位方向收益=g.方向收益.median()))
    nb = sum(1 for s in S if s[0] == "bottom"); nt = len(S) - nb
    rows.append(dict(数据=ds, 类型=f"(结构总数 底{nb}/顶{nt}，偏离仓位天数占比 {np.mean(delta != 0):.0%})"))
print(pd.DataFrame(rows).round(3).to_string(index=False))
