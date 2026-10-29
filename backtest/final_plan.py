import numpy as np, pandas as pd
from engine import load
from repo_sys import daily_bars, target_weights
from repo_bt import SETS
FEE = 0.001
def bars(sym):
    ts, o, h, l, c = load(SETS[f"{sym}全程"])
    b = daily_bars(ts, o, h, l, c); return b.reindex(range(b.index[0], b.index[-1] + 1)).ffill()
B, E = bars("BTC"), bars("ETH"); n = min(len(B), len(E)); B, E = B.iloc[:n], E.iloc[:n]
idx = pd.to_datetime(B.index.values * 86_400_000, unit="ms")
def tg(b, s): return target_weights(b.h.values, b.l.values, b.c.values, s)[0]
def sim(tb, te, reb):
    """两个子账户，各自按目标仓位次日开盘调仓；reb: None / 'M' / 'Q' / 'Y' 定期把两个子账户权益拉回各半（在开盘时）。"""
    cash = np.array([1000., 1000.]); qty = np.zeros(2); eq = np.empty(n)
    O = np.c_[B.o.values, E.o.values]; Cl = np.c_[B.c.values, E.c.values]; T = np.c_[tb, te]
    per = None if reb is None else idx.to_period(reb)
    for i in range(n):
        if i > 0:
            if per is not None and per[i] != per[i - 1]:
                v = cash + qty * O[i]; tot = v.sum()
                for k in range(2):  # 把子账户价值拉回 tot/2，按当前仓位比例缩放（买卖差额计手续费）
                    f = tot / 2 / v[k]; dq = qty[k] * (f - 1)
                    fee = abs(dq) * O[i, k] * FEE
                    qty[k] += dq; cash[k] = cash[k] * f - fee
            for k in range(2):
                want = T[i - 1, k]; prev = T[i - 2, k] if i > 1 else -1
                if want != prev:
                    v = cash[k] + qty[k] * O[i, k]; dv = want * v - qty[k] * O[i, k]
                    if dv > 0: qty[k] += dv * (1 - FEE) / O[i, k]; cash[k] -= dv
                    elif dv < 0: qty[k] += dv / O[i, k]; cash[k] += -dv * (1 - FEE)
        eq[i] = (cash + qty * Cl[i]).sum()
    return eq
def met(v):
    pk = np.maximum.accumulate(v); r = np.diff(v) / v[:-1]; yrs = n / 365
    w = np.array([v[min(x + 365, n - 1)] / v[x] - 1 for x in range(0, n - 365, 30)])
    return dict(期末U=v[-1], 年化=(v[-1] / v[0]) ** (1 / yrs) - 1, 最大回撤=((v - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365), 最差1年=w.min(), 亏损窗口=(w < 0).mean())
tb0, tb1, te0, te1 = tg(B, False), tg(B, True), tg(E, False), tg(E, True)
rows = []
for name, tb, te in [("都用纯趋势", tb0, te0), ("BTC加结构, ETH纯趋势", tb1, te0), ("都加结构", tb1, te1)]:
    for reb, rn in [(None, "独立不调"), ("Y", "每年调回各半"), ("Q", "每季调回各半"), ("M", "每月调回各半")]:
        rows.append(dict(信号=name, 再平衡=rn, **met(sim(tb, te, reb))))
pd.set_option("display.width", 250)
print(pd.DataFrame(rows).round(3).to_string(index=False))
# 2020 年以后、2017-2019 两段分别看推荐方案
for lo, hi in [("2017-08-17", "2019-12-31"), ("2020-01-01", "2026-09-30")]:
    m = (idx >= lo) & (idx <= hi)
    for name, tb, te in [("都用纯趋势", tb0, te0), ("BTC加结构, ETH纯趋势", tb1, te0)]:
        v = sim(tb, te, None)[m]; v = v / v[0] * 2000; pk = np.maximum.accumulate(v); r = np.diff(v) / v[:-1]
        print(lo[:4], "~", hi[:4], name, f"年化 {(v[-1]/v[0])**(365/len(v))-1:.1%} 回撤 {((v-pk)/pk).min():.1%} 夏普 {r.mean()/r.std()*np.sqrt(365):.2f}")
print("-- 再平衡分段检验（都用纯趋势）")
for lo, hi in [("2017-08-17", "2019-12-31"), ("2020-01-01", "2022-12-31"), ("2023-01-01", "2026-09-30")]:
    m = (idx >= lo) & (idx <= hi)
    for reb in (None, "M"):
        v = sim(tb0, te0, reb)[m]; v = v / v[0]; pk = np.maximum.accumulate(v); r = np.diff(v) / v[:-1]
        print(lo[:4], "~", hi[:4], "每月调回" if reb else "独立不调", f"年化 {v[-1]**(365/len(v))-1:6.1%} 回撤 {((v-pk)/pk).min():6.1%} 夏普 {r.mean()/r.std()*np.sqrt(365):.2f}")
