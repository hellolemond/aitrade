"""H 方案空单的最大不利波动：每笔空单持有期间，最高价相对开仓价最多涨了多少。"""
import numpy as np, pandas as pd
from futures_bt import spot_bars
from robust_eval import bars_1d
from repo_sys import trend_state
rows = []
B = {s: spot_bars(s) for s in ["BTC", "ETH"]}
for s in ["LTC", "XRP", "ADA", "DOT", "LINK", "BCH", "EOS", "TRX", "XLM", "ATOM", "FIL", "ETC", "UNI", "AVAX", "DOGE"]:
    B[s] = bars_1d(f"{s}USDT")
for s, b in B.items():
    O, H, L, C = (b[k].values for k in "ohlc"); st, _, _ = trend_state(H, L, C)
    mae = []; i = 1
    while i < len(C):
        if st[i - 1] == 0:                         # 第 i 天开盘开空
            ent = O[i]; j = i; hi = H[i]
            while j < len(C) and st[j - 1] == 0: hi = max(hi, H[j]); j += 1
            mae.append(hi / ent - 1); i = j
        else: i += 1
    mae = np.array(mae); day_up = (H / np.r_[C[0], C[:-1]] - 1).max()
    rows.append(dict(币=s, 空单笔数=len(mae), 最大不利涨幅=mae.max(), 第二大=np.sort(mae)[-2], 中位=np.median(mae),
                     超过30比例=(mae > 0.3).mean(), 超过50比例=(mae > 0.5).mean(), 最大单日涨幅=day_up))
pd.set_option("display.width", 250)
print(pd.DataFrame(rows).round(3).to_string(index=False))
