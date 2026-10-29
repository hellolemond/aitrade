import pandas as pd
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
df = pd.read_csv("robust.csv")
cols = ["kind","step","amt","depth","tp","trail","年化(按cap)","最大回撤","最大浮亏(持仓)","平均占用","资金收益率","触顶次数","窗口中位","窗口P10","窗口最差","亏损窗口占比"]
s = df[df.kind=="shadow"]
print("== shadow 按 窗口P10 top20"); print(s.sort_values("窗口P10", ascending=False)[cols].head(20).round(3).to_string(index=False))
print("== 用户原方案附近 step=0.5% depth=0.5"); print(s[(s.step==0.005)&(s.depth==0.5)][cols].round(3).to_string(index=False))
for k in ["step","depth","tp","trail"]:
    print("== shadow 按", k); print(s.groupby(k)[["年化(按cap)","最大回撤","资金收益率","窗口中位","窗口P10","窗口最差","亏损窗口占比"]].mean().round(3).to_string())
print("== shadow vs grid 同参数对比（均值）")
g = df[df.kind=="grid"]
m = s[s.trail==1].merge(g, on=["step","depth","tp"], suffixes=("_s","_g"))
print(m[["年化(按cap)_s","年化(按cap)_g","窗口P10_s","窗口P10_g","最大回撤_s","最大回撤_g"]].mean().round(3))
print("== grid 按 窗口P10 top8"); print(g.sort_values("窗口P10", ascending=False)[cols].head(8).round(3).to_string(index=False))
