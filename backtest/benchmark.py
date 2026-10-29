import numpy as np
from engine import load, run_grid
ts,o,h,l,c = load(); CAP=1000.; YRS=len(c)/1440/365
st,eq,cd = run_grid(o,h,l,c,0.01,12.5,CAP,0.05,0.001,False)
eq = eq[eq>0]; btc = c[1439::1440][:len(eq)]
def m(e, name):
    r = np.diff(e)/e[:-1]; pk=np.maximum.accumulate(e)
    ann=(e[-1]/e[0])**(1/YRS)-1; mdd=((e-pk)/pk).min()
    print(f"{name:22s} 年化 {ann:6.1%}  最大回撤 {mdd:6.1%}  夏普 {r.mean()/r.std()*np.sqrt(365):.2f}  收益/回撤 {ann/-mdd:.2f}")
m(eq, "E 网格")
m(CAP*btc/btc[0], "全仓持有BTC")
for w in (0.3, 0.5):
    # 每月再平衡到固定 BTC 比例
    e=[CAP]; b=w; 
    for i in range(1,len(btc)):
        v=e[-1]*(b*btc[i]/btc[i-1]+(1-b)); e.append(v)
    m(np.array(e), f"固定{int(w*100)}%BTC(每日再平衡)")
print("E 单利年化", st[0]/CAP/YRS)
