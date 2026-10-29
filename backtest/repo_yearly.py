import numpy as np, pandas as pd
from repo_scaled import curves
from engine import load
from repo_bt import SETS
pd.set_option("display.width", 250)
_, yb, ob = curves("BTC全程"); _, ye, oe = curves("ETH全程")
ts = load(SETS["BTC全程"])[0]; first = ts[0] // 86_400_000
cols = {"网格(BTC整体+3%,ETH单批+5%)": ("网格 整体+3%", "网格 单批+5%"), "纯趋势30%": ("纯趋势 仓位30%",) * 2,
        "纯趋势40%": ("纯趋势 仓位40%",) * 2, "趋势+结构30%": ("趋势+结构 仓位30%",) * 2}
out = {}
for name, (bk, ek) in cols.items():
    n = min(len(ob[bk]), len(oe[ek])); e = pd.Series(ob[bk][:n] + oe[ek][:n], index=pd.to_datetime((np.arange(n) + first) * 86_400_000, unit="ms"))
    y = e.groupby(e.index.year).last(); prev = np.r_[2000, y.values[:-1]]
    out[name] = (y.values / prev - 1)
idx = sorted(set(pd.to_datetime((np.arange(len(ob["网格 整体+3%"])) + first) * 86_400_000, unit="ms").year))
df = pd.DataFrame(out, index=idx[:len(next(iter(out.values())))])
bp = pd.Series(load(SETS["BTC全程"])[4][::1440]); ep = pd.Series(load(SETS["ETH全程"])[4][::1440])
print((df * 100).round(1).to_string())
