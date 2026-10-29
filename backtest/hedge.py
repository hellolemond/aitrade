"""现货只做多（主仓）+ 合约 1x 只做空（对冲仓），BTC/ETH 各半。各子账户独立运行；另测每年再平衡。"""
import numpy as np, pandas as pd
from final_bt import run as spot_run
from futures_bt import spot_bars, run as fut_run, met, detrended
pd.set_option("display.width", 250)
SB = {s: spot_bars(s) for s in ["BTC", "ETH"]}

def curves(bars, start):
    """返回 {币: (现货多头曲线, 合约空头曲线)}，都从 1 起。"""
    out = {}
    for s, b in bars.items():
        sp = spot_run(b[["o", "h", "l", "c"]], start=start)[0]; sp = sp / sp.iloc[0]
        sh = fut_run(b, 1, "只空", warm=start); sh = sh[0]
        idx = sp.index.intersection(sh.index); sh = sh[idx] / sh[idx].iloc[0]
        out[s] = (sp[idx], sh)
    return out

def combo(cv, w, reb=None):
    parts = []
    for s, (sp, sh) in cv.items():
        if reb is None:
            parts.append(0.5 * ((1 - w) * sp + w * sh))
        else:  # 每年初把该币子账户拉回 (1-w):w
            v = []; a, b_ = 0.5 * (1 - w), 0.5 * w; per = sp.index.to_period(reb)
            for i in range(len(sp)):
                if i > 0:
                    a *= sp.iloc[i] / sp.iloc[i - 1]; b_ *= sh.iloc[i] / sh.iloc[i - 1] if sh.iloc[i - 1] > 0 else 0
                    if per[i] != per[i - 1]: t = a + b_; a, b_ = t * (1 - w), t * w
                v.append(a + b_)
            parts.append(pd.Series(v, index=sp.index))
    return sum(parts)

rows = []
for lab, bars, start in [("2017-10~2026-09", SB, "2017-10-17"), ("2020-01~2026-09", SB, "2020-01-01"),
                         ("去趋势 年化0%", {s: detrended(b, 0.0) for s, b in SB.items()}, "2017-10-17"),
                         ("去趋势 年化-20%", {s: detrended(b, -0.2) for s, b in SB.items()}, "2017-10-17")]:
    cv = curves(bars, start)
    for w in (0.0, 0.1, 0.2, 0.3, 0.5):
        for reb in (None, "Y"):
            if w == 0 and reb: continue
            e = combo(cv, w, reb); m = met(e)
            y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0; g = y / p - 1
            rows.append(dict(区间=lab, 空单比例=w, 再平衡="每年" if reb else "不调", **m, 最差年=g.min(), 年2018=g.get(2018, np.nan), 年2022=g.get(2022, np.nan)))
print(pd.DataFrame(rows).round(3).to_string(index=False))

print("\n== 对照：空单那部分改成闲置现金（每年再平衡）")
rows = []
for lab, bars, start in [("2017-10~2026-09", SB, "2017-10-17"), ("2020-01~2026-09", SB, "2020-01-01"), ("去趋势 年化0%", {s: detrended(b, 0.0) for s, b in SB.items()}, "2017-10-17")]:
    cv = curves(bars, start)
    for w in (0.2, 0.3):
        for kind in ("合约空单", "现金"):
            c2 = cv if kind == "合约空单" else {s: (sp, pd.Series(1.0, index=sp.index)) for s, (sp, sh) in cv.items()}
            e = combo(c2, w, "Y"); y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0
            rows.append(dict(区间=lab, 比例=w, 另一部分=kind, **met(e), 最差年=(y / p - 1).min()))
print(pd.DataFrame(rows).round(3).to_string(index=False))
