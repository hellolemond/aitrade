import pandas as pd
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
df = pd.read_csv("sweep_shadow.csv"); gd = pd.read_csv("sweep_grid.csv")
cols = ["step","amt","深度","tp","first","parts","sstep","trail","总收益U","年化(按cap)","最大回撤","最大浮亏(持仓)","平均占用","清仓轮数","触顶次数","期末持仓成本U"]
ycols = [c for c in df.columns if c.startswith("y20")]
df["calmar"] = df["年化(按cap)"] / -df["最大回撤"]
df["最差年"] = df[ycols].min(axis=1)
print("== 按年化 top15"); print(df.sort_values("年化(按cap)", ascending=False)[cols+["calmar"]].head(15).round(4).to_string(index=False))
print("== 按 calmar top15"); print(df.sort_values("calmar", ascending=False)[cols+["calmar","最差年"]].head(15).round(4).to_string(index=False))
print("== 单因素均值（年化 / 回撤 / calmar）")
for k in ["step","amt","深度","tp","first","parts","trail"]:
    print(df.groupby(k)[["年化(按cap)","最大回撤","calmar","平均占用"]].mean().round(4).T.to_string()); print()
print("== sstep 倍数"); df["sm"]=(df.sstep/df.step).round(1); print(df.groupby("sm")[["年化(按cap)","最大回撤","calmar"]].mean().round(4))
gd["calmar"] = gd["年化(按cap)"] / -gd["最大回撤"]
print("== 网格基线 top10 calmar"); print(gd.sort_values("calmar", ascending=False)[["step","amt","深度","g","总收益U","年化(按cap)","最大回撤","最大浮亏(持仓)","平均占用","calmar"]].head(10).round(4).to_string(index=False))
