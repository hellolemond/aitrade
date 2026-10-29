import time, numpy as np
from engine import *
ts,o,h,l,c=load(); yrs=len(c)/1440/365
t=time.time()
st,eq,cd=run_shadow(o,h,l,c,0.005,10.,1000.,0.01,0.3,5.,0.005,0.001,5.,0,False)
print('compile+run',time.time()-t)
t=time.time()
st,eq,cd=run_shadow(o,h,l,c,0.005,10.,1000.,0.01,0.3,5.,0.005,0.001,5.,0,False)
print('run',time.time()-t)
for kk,v in summarize(st,eq,cd,1000,yrs).items(): print(kk, round(v,4))
st,eq,cd=run_grid(o,h,l,c,0.005,10.,1000.,0.01,0.001,False)
print('grid'); 
for kk,v in summarize(st,eq,cd,1000,yrs).items(): print(kk, round(v,4))
print('BTC', c[0], c[-1], 'hodl annual', (c[-1]/c[0])**(1/yrs)-1)
