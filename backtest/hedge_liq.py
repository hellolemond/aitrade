"""H 方案（套利 + 30% 做空）逐仓位模拟，含强平检查。每个币一套，BTC/ETH 各半。

主仓（70%）：多头持现货；空头期现货不动，开等量合约空单（统一账户，现货按折算率 hair 作抵押）。
  强平：现货抵押 × hair + USDT 余额 + 空单浮盈亏 ≤ 维持保证金（名义 × MM）
空单仓（30%）：空头期以全部资金为逐仓保证金开 lev 倍空单，持仓数量固定。
  强平：保证金 + 浮盈亏（含已收付资金费） ≤ 名义 × MM
价格检查用当日最高价（对空单最不利）；信号为前一日收盘状态，开盘成交。每年 1 月 1 日开盘把两仓拉回 70:30。
"""
import numpy as np, pandas as pd
from futures_bt import spot_bars, met, detrended
from repo_sys import trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
SPOT_FEE, FUT_FEE, MM = 0.001, 0.0005, 0.005


def run_h(b, start, w=0.3, lev=1.0, hair=0.95, carry=True):
    O, H, L, C, F = (b[k].values for k in ["o", "h", "l", "c", "fund"])
    st, _, _ = trend_state(H, L, C); idx = b.index; n = len(C)
    i0 = int(np.searchsorted(idx, pd.Timestamp(start)))
    # 主仓
    usd_m = 1 - w; qs = 0.0; qc = 0.0; ent_c = 0.0
    # 空单仓
    usd_d = w; qd = 0.0; ent_d = 0.0; mar_d = 0.0
    liq_c = liq_d = 0; worst_c = worst_d = 0.0   # 最差时「亏损 / 可用保证金」比例（1 = 强平）
    eq = np.full(n, np.nan)

    def close_d(px):
        nonlocal usd_d, qd, mar_d
        usd_d = mar_d + qd * (ent_d - px) - qd * px * FUT_FEE; qd = 0.0; mar_d = 0.0

    def close_c(px):
        nonlocal usd_m, qc
        usd_m += qc * (ent_c - px) - qc * px * FUT_FEE; qc = 0.0

    for i in range(i0 + 1, n):
        sig = st[i - 1]; px = O[i]
        # 年初再平衡
        if idx[i].year != idx[i - 1].year and i > i0 + 1:
            if qd > 0: close_d(px)
            vm = usd_m + qs * px + qc * (ent_c - px); tot = vm + usd_d
            delta = tot * (1 - w) - vm                      # 正：空单仓转给主仓
            usd_m += delta; usd_d -= delta
            if delta < 0 and usd_m < 0:                     # 主仓现金不够：卖部分现货
                sell = -usd_m / (px * (1 - SPOT_FEE)); qs -= sell; usd_m = 0.0
                if qc > 0: close_c(px); qc = qs; ent_c = px; usd_m -= qc * px * FUT_FEE
        # 主仓
        if sig == 1:
            if qc > 0: close_c(px)
            if usd_m > 0: qs += usd_m * (1 - SPOT_FEE) / px; usd_m = 0.0
            elif usd_m < 0: qs -= -usd_m / (px * (1 - SPOT_FEE)); usd_m = 0.0   # 套利空单亏损：卖现货补足
        else:
            if carry:
                if qs == 0 and usd_m > 0:                   # 回测开头若处于空头：先买现货
                    qs = usd_m * (1 - SPOT_FEE) / px; usd_m = 0.0
                if qc == 0 and qs > 0: qc = qs; ent_c = px; usd_m -= qc * px * FUT_FEE
            elif qs > 0:
                usd_m += qs * px * (1 - SPOT_FEE); qs = 0.0
        # 空单仓
        if sig == 0 and qd == 0 and usd_d > 0:
            qd = usd_d * lev / px; mar_d = usd_d - qd * px * FUT_FEE; ent_d = px; usd_d = 0.0
        elif sig == 1 and qd > 0:
            close_d(px)
        # 资金费（空单收取正费率）
        if qc > 0: usd_m += qc * C[i] * F[i]
        if qd > 0: mar_d += qd * C[i] * F[i]
        # 强平检查（当日最高价）
        hp = H[i]
        if qc > 0:
            coll = qs * hp * hair + usd_m + qc * (ent_c - hp); mm = qc * hp * MM
            base = qs * ent_c * hair + usd_m                 # 开仓时的可用抵押
            worst_c = max(worst_c, (base - coll) / max(base - qc * ent_c * MM, 1e-12))
            if coll <= mm:
                liq_c += 1; usd_m = coll; qs = 0.0; qc = 0.0     # 强平：抵押被清算，只剩净值
        if qd > 0:
            loss = qd * (hp - ent_d); room = mar_d - qd * hp * MM
            worst_d = max(worst_d, loss / max(mar_d, 1e-12))
            if loss >= room:
                liq_d += 1; usd_d = max(mar_d - loss, 0.0); qd = 0.0; mar_d = 0.0
        eq[i] = usd_m + qs * C[i] + qc * (ent_c - C[i]) + usd_d + mar_d + qd * (ent_d - C[i])
    e = pd.Series(eq, index=idx).dropna()
    return e / e.iloc[0], dict(套利强平=liq_c, 空单强平=liq_d, 套利最差亏损占可用保证金=worst_c, 空单最差亏损占保证金=worst_d)


if __name__ == "__main__":
    SB = {s: spot_bars(s) for s in ["BTC", "ETH"]}
    scen = [("2017-10~2026-09", SB, "2017-10-17"), ("2020-01~2026-09", SB, "2020-01-01"),
            ("去趋势 0%", {s: detrended(b, 0.0) for s, b in SB.items()}, "2017-10-17"),
            ("去趋势 -20%", {s: detrended(b, -0.2) for s, b in SB.items()}, "2017-10-17")]
    rows = []
    for lab, bars, start in scen:
        for name, kw in [("A 基础版", dict(w=0.0, carry=False)), ("E 套利版", dict(w=0.0)),
                         ("H 对冲版 1x", dict(w=0.3, lev=1)), ("H 对冲版 1x 折算0.8", dict(w=0.3, lev=1, hair=0.8)),
                         ("H 对冲版 2x", dict(w=0.3, lev=2)), ("H 对冲版 3x", dict(w=0.3, lev=3))]:
            es, info = [], {}
            for s, b in bars.items():
                e, d = run_h(b, start, **kw); es.append(e)
                for k, v in d.items(): info[f"{s}{k}"] = v
            e = (es[0] + es[1]) / 2; e = e.dropna()
            y = e.groupby(e.index.year).last(); p = y.shift(1); p.iloc[0] = 1.0
            rows.append(dict(区间=lab, 方案=name, **met(e), 最差年=(y / p - 1).min(),
                             强平次数=sum(v for k, v in info.items() if "强平" in k),
                             BTC空单最差=info["BTC空单最差亏损占保证金"], ETH空单最差=info["ETH空单最差亏损占保证金"],
                             套利最差=max(info["BTC套利最差亏损占可用保证金"], info["ETH套利最差亏损占可用保证金"])))
    df = pd.DataFrame(rows)
    for lab, g in df.groupby("区间", sort=False):
        print(f"\n== {lab}"); print(g.drop(columns="区间").round(3).to_string(index=False))
