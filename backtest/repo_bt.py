"""仓库策略单独回测 + 与网格的两种结合。"""
import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from engine3 import run_trend
from repo_sys import daily_bars, target_weights, run_weights, trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)
CAP, FEE = 1000., 0.001
LV = np.arange(1, 96) * 0.01; AM = np.full(95, CAP / 95)
SETS = {"BTC全程": "data/btcusdt_1m_2017_2026.npz", "ETH全程": "data/ethusdt_1m_2017_2026.npz",
        "BTC样本内": "data/btcusdt_1m.npz", "ETH样本内": "data/ethusdt_1m.npz", "BNB样本内": "data/bnbusdt_1m.npz", "SOL样本内": "data/solusdt_1m.npz",
        "BTC样本外": "data/btcusdt_1m_2017_2019.npz", "ETH样本外": "data/ethusdt_1m_2017_2019.npz", "BNB样本外": "data/bnbusdt_1m_2017_2019.npz"}

def met(e, yrs):
    e = e[e > 0]; pk = np.maximum.accumulate(e); r = np.diff(e) / e[:-1]
    w = np.array([e[min(x + 365, len(e) - 1)] / e[x] - 1 for x in range(0, len(e) - 365, 30)])
    return dict(年化=(e[-1] / e[0]) ** (1 / yrs) - 1, 最大回撤=((e - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365), 最差1年=w.min(), 亏损窗口=(w < 0).mean())

def curves(ds):
    ts, o, h, l, c = load(SETS[ds]); yrs = len(c) / 1440 / 365
    db = daily_bars(ts, o, h, l, c)
    first = db.index[0]; db = db.reindex(range(first, db.index[-1] + 1)).ffill()
    O, H, L, C = (db[k].values for k in "ohlc")
    out = {}
    tgt, st = target_weights(H, L, C, use_structure=False)
    out["仓库:纯趋势"] = run_weights(O, C, tgt)[0]
    tgt2, _ = target_weights(H, L, C, use_structure=True)
    out["仓库:趋势+结构"] = run_weights(O, C, tgt2)[0]
    out["持有100%"] = CAP * C / C[0]
    # 网格（引擎按分钟，dayid 相对首日）
    day = (ts // 86_400_000) - first
    nan = np.full(len(C), np.nan)
    up_prev = np.where(np.r_[0, st[:-1]] == 1, 0.0, np.nan)      # 前一日收盘为多头 → 当日即处于趋势
    up_prev[0] = np.nan
    exit_line = np.where(st == 0, np.inf, np.nan)                  # 收盘为空头 → 离场
    g = {}
    g["网格 整体+3%"] = run_trend(o, h, l, c, day, nan, nan, LV, AM, 0.03, 1, FEE, False, 0.0)[1]
    g["网格 单批+5%"] = run_trend(o, h, l, c, day, nan, nan, LV, AM, 0.05, 0, FEE, False, 0.0)[1]
    g["网格 整体+3% | 多头暂停止盈"] = run_trend(o, h, l, c, day, up_prev, exit_line, LV, AM, 0.03, 1, FEE, True, 0.0)[1]
    g["网格 单批+5% | 多头暂停止盈"] = run_trend(o, h, l, c, day, up_prev, exit_line, LV, AM, 0.05, 0, FEE, True, 0.0)[1]
    g["网格 整体+3%留50% | 转空卖出"] = run_trend(o, h, l, c, day, nan, exit_line, LV, AM, 0.03, 1, FEE, False, 0.5)[1]
    n = len(C)
    for k, v in g.items(): out[k] = v[:n]
    out["50%网格整体+3% + 50%仓库系统"] = 0.5 * out["网格 整体+3%"] + 0.5 * out["仓库:趋势+结构"]
    out["50%网格单批+5% + 50%仓库系统"] = 0.5 * out["网格 单批+5%"] + 0.5 * out["仓库:趋势+结构"]
    out["50%网格单批+5% + 50%纯趋势"] = 0.5 * out["网格 单批+5%"] + 0.5 * out["仓库:纯趋势"]
    return ds, yrs, out, int(np.sum(np.diff(st) != 0))

if __name__ == "__main__":
    with Pool(8) as pool: res = pool.map(curves, list(SETS))
    rows, C = [], {}
    for ds, yrs, out, flips in res:
        C[ds] = (yrs, out)
        for k, e in out.items(): rows.append(dict(数据=ds, 方案=k, **met(e, yrs)))
        print(f"{ds}: 趋势翻转 {flips} 次")
    df = pd.DataFrame(rows); df.to_csv("repo_bt.csv", index=False)
    order = list(res[0][2].keys())
    for k in ["年化", "最大回撤", "夏普"]:
        print(f"\n== {k}"); print(df.pivot_table(index="方案", columns="数据", values=k).reindex(order).round(2).to_string())
    print("\n== BTC、ETH 各 1000U（2017-2026）组合")
    yrs, ob = C["BTC全程"]; _, oe = C["ETH全程"]
    pr = []
    for bk in order:
        for ek in order:
            if bk == "持有100%" or ek == "持有100%": continue
            n = min(len(ob[bk]), len(oe[ek])); pr.append(dict(BTC=bk, ETH=ek, **met(ob[bk][:n] + oe[ek][:n], yrs)))
    pr = pd.DataFrame(pr)
    print("-- 夏普前 12"); print(pr.sort_values("夏普", ascending=False).head(12).round(3).to_string(index=False))
    same = pr[pr.BTC == pr.ETH].sort_values("夏普", ascending=False)
    print("-- 两个币用同一方案"); print(same.round(3).to_string(index=False))
