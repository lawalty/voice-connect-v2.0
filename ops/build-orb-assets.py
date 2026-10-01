"""Offline preparation of the approved expression artwork (numpy + opencv-python).
Runtime does not use Python or perform optical-flow inference.
"""
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parent.parent
if (ROOT/'.local/orb-concept/deps').exists():sys.path.insert(0,str(ROOT/'.local/orb-concept/deps'))
import cv2,numpy as np
S=256
atlas=cv2.imread(str(ROOT/'design-assets/luminous-glass/expression-source.png'))
mask=(atlas.max(axis=2)>65).astype(np.uint8)*255
mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15)))
_,_,stats,_=cv2.connectedComponentsWithStats(mask)
boxes=sorted([b for b in stats[1:] if b[4]>10000],key=lambda b:(round(float(b[1])/380),b[0]))
assert len(boxes)==9
sprites=[]
for x,y,w,h,_ in boxes:
    side=round(max(w,h)*1.17)
    crop=cv2.getRectSubPix(atlas,(side,side),(x+w/2,y+h/2))
    sprites.append(cv2.resize(crop,(S,S),interpolation=cv2.INTER_AREA).astype(np.float32))
yy,xx=np.mgrid[0:S,0:S].astype(np.float32)
def ellipse(cx,cy,rx,ry):
    d=((xx-cx/2)/(rx/2))**2+((yy-cy/2)/(ry/2))**2
    z=np.clip((d-.55)/.45,0,1)
    return (1-z*z*(3-2*z))[...,None]
face=ellipse(256,295,189,178);eyes=ellipse(256,246,160,70);mouth=ellipse(256,379,122,83)
base=sprites[0]; masks=[face,eyes,face,mouth,mouth,mouth,mouth,face,face]
targets=[np.clip(base+(s-base)*m,0,255).astype(np.uint8) for s,m in zip(sprites,masks)]
colors=np.zeros((S*3,S*3,3),np.uint8);flowmap=np.zeros((S*3,S*3,4),np.uint8)
grey0=cv2.cvtColor(base.astype(np.uint8),cv2.COLOR_BGR2GRAY)
for idx,target in enumerate(targets):
    grey=cv2.cvtColor(target,cv2.COLOR_BGR2GRAY)
    engine=cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    f=engine.calc(grey0,grey,None);b=engine.calc(grey,grey0,None)
    # RG = forward XY; BA = backward XY. +/- 0.25 of a cell, neutral 128.
    rgba=np.rint(np.clip(np.concatenate([f,b],axis=2)/S*508+128,1,255)).astype(np.uint8)
    row,col=divmod(idx,3);region=np.s_[row*S:(row+1)*S,col*S:(col+1)*S]
    colors[region]=target;flowmap[region]=rgba[:,:,[2,1,0,3]]
out=ROOT/'client/public/orb-packs/luminous-glass'
out.mkdir(parents=True,exist_ok=True)
cv2.imwrite(str(out/'atlas.png'),colors,[cv2.IMWRITE_PNG_COMPRESSION,9])
cv2.imwrite(str(out/'flow.png'),flowmap,[cv2.IMWRITE_PNG_COMPRESSION,9])
print('Prepared 768px expression atlas and flow map:',[(p.name,p.stat().st_size) for p in out.glob('*.png')])
