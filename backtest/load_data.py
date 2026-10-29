"""把 Binance 月度 1m K 线 zip 合并成一个 npz（时间戳统一为毫秒）。"""
import glob
import sys
import zipfile

import numpy as np
import pandas as pd

# 用法: python load_data.py SYM [起始年 结束年]；不给年份时为 2020-2026（样本内），否则输出带年份后缀的文件
SYM = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
Y0, Y1 = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (2020, 2026)
OUT = f"data/{SYM.lower()}_1m.npz" if len(sys.argv) <= 3 else f"data/{SYM.lower()}_1m_{Y0}_{Y1}.npz"
frames = []
for path in sorted(glob.glob(f"data/raw/{SYM}-1m-*.zip")):
    if not Y0 <= int(path.split("-1m-")[1][:4]) <= Y1:
        continue
    with zipfile.ZipFile(path) as z:
        with z.open(z.namelist()[0]) as f:
            df = pd.read_csv(f, header=None, usecols=[0, 1, 2, 3, 4])
    # 2025 年起现货数据时间戳为微秒
    ts = df[0].astype("int64")
    df[0] = np.where(ts > 10**14, ts // 1000, ts)
    frames.append(df)

df = pd.concat(frames, ignore_index=True)
df.columns = ["ts", "open", "high", "low", "close"]
df = df.drop_duplicates("ts").sort_values("ts")
np.savez(OUT, **{c: df[c].to_numpy() for c in df.columns})
print(len(df), pd.to_datetime(df.ts.iloc[0], unit="ms"), pd.to_datetime(df.ts.iloc[-1], unit="ms"))
