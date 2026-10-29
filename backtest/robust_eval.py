"""剔除牛市影响的稳健性检验：最终方案（日线 EMA32 高低通道，100% 仓位，次日开盘成交，单边 0.1%）。

1. 去趋势回测   2. 分块自助抽样（漂移 0 / -30% / +30% 每年）   3. 随机择时对照
4. 按季度行情类型拆分   5. 15 个其他币种（2020-2026）
"""
import glob, zipfile
import numpy as np, pandas as pd
from multiprocessing import Pool
from engine import load
from repo_sys import daily_bars, trend_state
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
FEE = 0.001
RNG = np.random.default_rng(42)


def strat(O, H, L, C, fee=FEE):
    """返回每日权益（起始 1）与持仓序列。"""
    st, _, _ = trend_state(H, L, C)
    n = len(C); cash, qty = 1.0, 0.0; eq = np.empty(n); pos = np.zeros(n)
    for i in range(n):
        if i > 0:
            if st[i - 1] == 1 and qty == 0: qty = cash * (1 - fee) / O[i]; cash = 0.0
            elif st[i - 1] == 0 and qty > 0: cash = qty * O[i] * (1 - fee); qty = 0.0
        eq[i] = cash + qty * C[i]; pos[i] = qty > 0
    return eq, pos


def met(eq):
    yrs = len(eq) / 365; pk = np.maximum.accumulate(eq); r = np.diff(eq) / eq[:-1]
    return dict(年化=eq[-1] ** (1 / yrs) - 1 if eq[0] == 1 else (eq[-1] / eq[0]) ** (1 / yrs) - 1,
                最大回撤=((eq - pk) / pk).min(), 夏普=r.mean() / r.std() * np.sqrt(365) if r.std() > 0 else 0)


def bars_npz(path):
    ts, o, h, l, c = load(path); b = daily_bars(ts, o, h, l, c)
    b = b.reindex(range(b.index[0], b.index[-1] + 1)).ffill(); b.index = pd.to_datetime(b.index.values * 86_400_000, unit="ms")
    return b


def bars_1d(sym):
    fr = []
    for p in sorted(glob.glob(f"data/raw1d/{sym}-1d-*.zip")):
        with zipfile.ZipFile(p) as z, z.open(z.namelist()[0]) as f:
            fr.append(pd.read_csv(f, header=None, usecols=[0, 1, 2, 3, 4]))
    d = pd.concat(fr); t = d[0].astype("int64"); d[0] = np.where(t > 10**14, t // 1000, t)
    d = d.drop_duplicates(0).sort_values(0); d.index = pd.to_datetime(d[0], unit="ms").dt.normalize()
    d = d.rename(columns={1: "o", 2: "h", 3: "l", 4: "c"})[["o", "h", "l", "c"]]
    return d.reindex(pd.date_range(d.index[0], d.index[-1])).ffill()


def detrend(b, drift_year=0.0):
    """把整段的平均对数涨幅替换为 drift_year（年化），四个价格同步平移，保留日内形态与波动。"""
    C = b.c.values; t = np.arange(len(C))
    mu = np.log(C[-1] / C[0]) / (len(C) - 1); nu = np.log(1 + drift_year) / 365
    f = np.exp((nu - mu) * t)
    return b.o.values * f, b.h.values * f, b.l.values * f, C * f


def boot_paths(b, n_paths, days, drift_year, block=30):
    """平稳分块自助抽样：按日对数收益（以前收盘为基准的 O/H/L/C 四元组）抽样，平均块长 block 天。"""
    C = b.c.values; pc = C[:-1]
    rel = np.log(np.c_[b.o.values[1:], b.h.values[1:], b.l.values[1:], C[1:]] / pc[:, None])
    mu = rel[:, 3].mean(); rel = rel - mu + np.log(1 + drift_year) / 365   # 整日平移
    m = len(rel); out = []
    for _ in range(n_paths):
        idx = np.empty(days, dtype=int); i = RNG.integers(m)
        for k in range(days):
            if k > 0 and RNG.random() < 1 / block: i = RNG.integers(m)
            idx[k] = i; i = (i + 1) % m
        r = rel[idx]; lc = np.cumsum(r[:, 3]); prev = np.r_[0, lc[:-1]]
        O, H, L, Cc = (np.exp(prev + r[:, j]) for j in range(4))
        H = np.maximum.reduce([H, O, Cc]); L = np.minimum.reduce([L, O, Cc])
        out.append((O, H, L, Cc))
    return out


def boot_job(args):
    name, b, drift, n = args
    res = []
    for O, H, L, C in boot_paths(b, n, 5 * 365, drift):
        eq, _ = strat(O, H, L, C); m = met(eq); hold = C[-1] / O[0]
        res.append((eq[-1], m["最大回撤"], hold, met(C / O[0])["最大回撤"]))
    return name, drift, np.array(res)


def random_timing(b, n=1000):
    """保留真实持仓/空仓段数与长度，随机打乱它们的先后顺序。"""
    O, H, L, C = b.o.values, b.h.values, b.l.values, b.c.values
    eq, pos = strat(O, H, L, C)
    runs = []; cur = pos[0]; ln = 0
    for p in pos:
        if p == cur: ln += 1
        else: runs.append((cur, ln)); cur, ln = p, 1
    runs.append((cur, ln))
    on = [l for p, l in runs if p]; off = [l for p, l in runs if not p]
    r = np.r_[0, O[1:] / O[:-1] - 1]          # 开盘到开盘
    finals = []
    for _ in range(n):
        a, bb = RNG.permutation(on), RNG.permutation(off); seq = []
        for k in range(max(len(a), len(bb))):
            if k < len(bb): seq += [0] * bb[k]
            if k < len(a): seq += [1] * a[k]
        seq = np.array(seq[:len(C)]); trades = np.abs(np.diff(np.r_[0, seq])).sum()
        g = np.prod(1 + r * np.r_[0, seq[:-1]]) * (1 - FEE) ** trades
        finals.append(g)
    finals = np.array(finals)
    return eq[-1] / 1.0, finals, pos.mean()


if __name__ == "__main__":
    B = {"BTC": bars_npz("data/btcusdt_1m_2017_2026.npz"), "ETH": bars_npz("data/ethusdt_1m_2017_2026.npz")}

    print("========== 1. 去趋势回测（2017-08 ~ 2026-09，把长期涨幅换成指定值）")
    rows = []
    for s, b in B.items():
        for d in (None, 0.0, -0.2):
            if d is None: O, H, L, C = b.o.values, b.h.values, b.l.values, b.c.values; lab = "原始价格"
            else: O, H, L, C = detrend(b, d); lab = f"长期年化改为 {d:+.0%}"
            eq, pos = strat(O, H, L, C); m = met(eq); hm = met(C / O[0])
            rows.append(dict(币=s, 价格=lab, 策略年化=m["年化"], 策略回撤=m["最大回撤"], 策略夏普=m["夏普"], 持有年化=hm["年化"], 持有回撤=hm["最大回撤"], 持币时间=pos.mean()))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\n========== 2. 分块自助抽样：1000 条 × 5 年，平均块长 30 天")
    jobs = [(s, B[s], d, 250) for s in B for d in (0.0, -0.3, 0.3) for _ in range(4)]
    with Pool(8) as pool: out = pool.map(boot_job, jobs)
    agg = {}
    for s, d, r in out: agg.setdefault((s, d), []).append(r)
    rows = []
    for (s, d), lst in agg.items():
        r = np.vstack(lst); sa = r[:, 0] ** (1 / 5) - 1; ha = r[:, 2] ** (1 / 5) - 1
        rows.append(dict(币=s, 假设长期年化=f"{d:+.0%}", 样本=len(r), 策略年化中位=np.median(sa), 策略P10=np.percentile(sa, 10), 策略P90=np.percentile(sa, 90),
                         策略5年亏损概率=(r[:, 0] < 1).mean(), 策略回撤中位=np.median(r[:, 1]), 持有年化中位=np.median(ha), 持有回撤中位=np.median(r[:, 3]),
                         策略跑赢持有概率=(r[:, 0] > r[:, 2]).mean()))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\n========== 3. 随机择时对照（真实价格，持仓段长度不变、顺序随机，1000 次）")
    rows = []
    for s, b in B.items():
        for lo, hi in [("2017-08-17", "2026-09-30"), ("2017-08-17", "2019-12-31"), ("2020-01-01", "2022-12-31"), ("2023-01-01", "2026-09-30")]:
            bb = b[(b.index >= lo) & (b.index <= hi)]
            real, fin, expo = random_timing(bb)
            rows.append(dict(币=s, 区间=f"{lo[:7]}~{hi[:7]}", 策略倍数=real, 随机中位倍数=np.median(fin), 随机P90倍数=np.percentile(fin, 90), 策略超过随机比例=(fin < real).mean(), 持币时间=expo))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\n========== 4. 按季度行情类型拆分（季度涨幅 >+25% 牛，<-20% 熊，其余震荡）")
    rows = []
    for s, b in B.items():
        eq, _ = strat(b.o.values, b.h.values, b.l.values, b.c.values)
        e = pd.Series(eq, index=b.index); px = b.c
        q = pd.DataFrame({"策略": e.resample("QE").last(), "价格": px.resample("QE").last()})
        q = q / q.shift(1) - 1; q = q.dropna()
        q["类型"] = np.where(q.价格 > 0.25, "牛", np.where(q.价格 < -0.20, "熊", "震荡"))
        for t, g in q.groupby("类型"):
            rows.append(dict(币=s, 类型=t, 季度数=len(g), 策略季均=g.策略.mean(), 持有季均=g.价格.mean(), 策略季中位=g.策略.median(), 策略亏损季占比=(g.策略 < 0).mean()))
        # 三类行情各占 1/3 的「中性」期望年化
        m = q.groupby("类型")[["策略", "价格"]].apply(lambda g: np.exp(np.log1p(g).mean()))
        rows.append(dict(币=s, 类型="三类等权→年化", 策略季均=m.策略.prod() ** (4 / 3) - 1, 持有季均=m.价格.prod() ** (4 / 3) - 1))
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\n========== 5. 其他 15 个币（2020-2026，含下跌和横盘的币）")
    rows = []
    for s in ["LTC", "XRP", "ADA", "DOT", "LINK", "BCH", "EOS", "TRX", "XLM", "ATOM", "FIL", "ETC", "UNI", "AVAX", "DOGE"]:
        b = bars_1d(f"{s}USDT"); eq, pos = strat(b.o.values, b.h.values, b.l.values, b.c.values)
        m = met(eq); hm = met(b.c.values / b.o.values[0])
        rows.append(dict(币=s, 起=b.index[0].date(), 止=b.index[-1].date(), 价格涨跌=b.c.iloc[-1] / b.o.iloc[0] - 1, 持有年化=hm["年化"], 持有回撤=hm["最大回撤"],
                         策略年化=m["年化"], 策略回撤=m["最大回撤"], 策略夏普=m["夏普"], 持有夏普=hm["夏普"], 持币时间=pos.mean()))
    d = pd.DataFrame(rows); print(d.round(3).to_string(index=False))
    print(f"-- 策略赚钱 {int((d.策略年化 > 0).sum())}/15，跑赢持有 {int((d.策略年化 > d.持有年化).sum())}/15，"
          f"策略年化中位 {d.策略年化.median():.1%}，持有年化中位 {d.持有年化.median():.1%}，策略回撤中位 {d.策略回撤.median():.1%}，持有回撤中位 {d.持有回撤.median():.1%}")
    down = d[d.价格涨跌 < 0]
    print(f"-- 其中价格下跌的 {len(down)} 个币：策略年化中位 {down.策略年化.median():.1%}，持有年化中位 {down.持有年化.median():.1%}，策略赚钱 {int((down.策略年化 > 0).sum())}/{len(down)}")
