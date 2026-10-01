"""Reproducible authoring examples; no raster artwork or third-party libraries.

Hermes geometry: orbFaceModel.ts at 318dfac932c454567e00494f5883261b32d8e60b.
The files are consumed by the generic renderer, never special-cased by pack ID.
"""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/vector-face/examples'
OUT.mkdir(parents=True, exist_ok=True)

def path(*commands): return dict(kind='path', commands=list(commands))
def ellipse(cx, cy, rx, ry): return dict(kind='ellipse', cx=cx, cy=cy, rx=rx, ry=ry)
def eye(cx, upper=9.2, lower=8.6):
    w, k = 10.5, .5523
    return path(['M', cx-w, 46], ['C',cx-w,46-upper*k,cx-w*k,46-upper,cx,46-upper],
      ['C',cx+w*k,46-upper,cx+w,46-upper*k,cx+w,46],
      ['C',cx+w,46+lower*k,cx+w*k,46+lower,cx,46+lower],
      ['C',cx-w*k,46+lower,cx-w,46+lower*k,cx-w,46],['Z'])
def brow(side, inner=0, outer=0, arch=1):
    sign = -1 if side == 'left' else 1
    ix, ox = 50+sign*9, 50+sign*32
    iy, oy = 28+inner, 28+outer
    mx, my = (ix+ox)/2, (iy+oy)/2-arch*4.4
    return path(['M',ox,oy-1.4],['Q',mx,my-2.9,ix,iy-2.9],['L',ix,iy+2.9],['Q',mx,my+2.465,ox,oy+1.4],['Z'])
def mouth(opening=0, width=1, curve=.18, skew=0):
    cx, w = 50+skew, (15.5+opening*6.5)*width
    y = 68
    return path(['M',cx-w,y-curve*3.4],['Q',cx,y+curve*4.6-opening*3.2-1.2,cx+w,y-curve*3.4],
      ['Q',cx,y+curve*5.4+opening*30,cx-w,y-curve*3.4],['Z'])
def bind(channel, prop, amount): return dict(channel=channel,property=prop,amount=amount)
nodes = [dict(id='head',layer='body',geometry=dict(kind='circle',cx=50,cy=50,r=46),fill='$state')]
for side,cx in [('left',32),('right',69)]:
    blink = 'blinkLeft' if side == 'left' else 'blinkRight'
    nodes.append(dict(id=f'brow-{side}',geometry=brow(side),fill='$features',
      morphs={('browLeft' if side=='left' else 'browRight'):brow(side,-3,-5,1.3),
        ('browInnerLeft' if side=='left' else 'browInnerRight'):brow(side,3,-1,.7),'sleep':brow(side,3,3,.35)},
      bindings=[bind('vowel','y',-1.15),bind('breath','y',-.35)]))
    nodes.append(dict(id=f'eye-{side}',geometry=eye(cx),fill='$features',
      morphs={blink:eye(cx,.35,.35),'sleep':eye(cx,-2.4,3.6),'focus':eye(cx,5.2,4.2)},
      bindings=[bind('error','opacity',-1)]))
    gaze=[bind('gazeX','x',4.1),bind('gazeY','y',3.3),bind('error','opacity',-1),bind('sleep','opacity',-1)]
    nodes.append(dict(id=f'pupil-{side}',geometry=ellipse(cx,46,4.3,4.988),fill='$pupils',clip=f'eye-{side}',bindings=gaze))
    for suffix,dx,dy,r,opacity in [('a',-1.376,-1.806,1.29,1),('b',1.462,1.892,.688,.8)]:
        nodes.append(dict(id=f'catchlight-{suffix}-{side}',geometry=dict(kind='circle',cx=cx+dx,cy=46+dy,r=r),fill='$features',opacity=opacity,clip=f'eye-{side}',bindings=gaze))
nodes.extend([
  dict(id='x-eyes',geometry=path(['M',24,40],['L',40,55],['M',40,40],['L',24,55],['M',61,40],['L',77,55],['M',77,40],['L',61,55]),fill='none',stroke='$features',strokeWidth=5,opacity=0,bindings=[bind('error','opacity',1)]),
  dict(id='nose',geometry=path(['M',50,53],['Q',47,58,51,60],['Q',55,62,58,58]),fill='none',stroke='$features',strokeWidth=2.6),
])
mouth_morphs={'mouthOpen':mouth(1),'mouthRound':mouth(0,.48),'mouthWide':mouth(0,1.3),'smile':mouth(0,1.1,.9),'focus':mouth(0,.8,-.08,2.1),'error':mouth(0,.9,-.5),'sleep':mouth(.045,.4,.05)}
nodes.extend([
  dict(id='mouth-fill',geometry=mouth(),fill='#261d16',opacity=0,morphs=mouth_morphs,bindings=[bind('mouthOpen','opacity',12),bind('sleep','opacity',.5)]),
  dict(id='tongue',geometry=path(['M',41.3,68.8],['Q',50,71,58.7,68.8],['Q',50,67.4,41.3,68.8],['Z']),fill='#d66c74',opacity=0,clip='mouth',
    morphs={'mouthOpen':path(['M',38,79],['Q',50,86,62,79],['Q',50,77.4,38,79],['Z'])},bindings=[bind('mouthOpen','opacity',2.8),bind('sleep','opacity',-1)]),
  dict(id='mouth',geometry=mouth(),fill='none',stroke='$features',strokeWidth=2.7,morphs=mouth_morphs),
])
# Tongue is visible only beyond a wide opening: a negative baseline is encoded
# with its opacity and a dedicated channel in the runtime (mouthWide is not it).
nodes[-2]['opacity'] = 0
for side,cx in [('left',22),('right',79)]:
    nodes.append(dict(id=f'cheek-{side}',geometry=ellipse(cx,58,7.2,3.6),fill='#f08a82',opacity=0,bindings=[bind('smile','opacity',.35)]))
accents = [
 ('zzz','zzz',path(['M',72,24],['L',79,24],['L',72,31],['L',80,31],['M',80,15],['L',85,15],['L',80,20],['L',86,20])),
 ('ears','ears',path(['M',14,44],['Q',10,48,14,52],['M',86,43],['Q',91,48,86,53])),
 ('thought','thought',path(['M',74,17],['C',74,14,78,14,78,17],['C',78,20,74,20,74,17],['Z'],['M',81,12],['C',81,8,87,8,87,12],['C',87,16,81,16,81,12],['Z'],['M',89,6],['C',89,1,96,1,96,6],['C',96,11,89,11,89,6],['Z'])),
 ('work','work',path(['M',13,37],['L',9,34],['M',12,45],['L',6,45],['M',87,37],['L',91,34],['M',88,45],['L',94,45])),
 ('error','error',path(['M',26,17],['Q',35,10,44,17],['Q',52,24,61,17],['Q',69,11,77,17])),
]
for name,channel,geometry in accents:
    nodes.append(dict(id=f'accent-{name}',layer='accent',geometry=geometry,fill='$features' if name=='thought' else 'none',
      stroke=None if name=='thought' else '$features',strokeWidth=2.6,opacity=0,
      bindings=[bind(channel,'opacity',.45),dict(channel='accentPulse',property='opacity',amount=.4,when=channel)] +
        ([bind('accentRise','y',-2.5)] if name in ['zzz','thought'] else [bind('accentPulse','x',4)] if name=='error' else [])))
    if nodes[-1]['stroke'] is None: del nodes[-1]['stroke']
poses={
 'idle':dict(channels={'sleep':1,'zzz':1}),
 'standby':dict(channels={'blinkLeft':.48,'blinkRight':.48,'sleep':.15,'smile':.18}),
 'connecting':dict(channels={'browLeft':.25,'browRight':.25}),
 'listening':dict(channels={'browLeft':.2,'browRight':.2,'ears':1,'smile':.12}),
 'thinking':dict(channels={'thought':1},variants=[
   dict(channels={'gazeX':.7,'gazeY':-.75,'browLeft':.7,'browRight':-.2,'focus':.3},holdMs=2100),
   dict(channels={'gazeX':.1,'gazeY':-.1,'focus':.8,'browInnerLeft':.5,'browInnerRight':.5},holdMs=1700),
   dict(channels={'gazeX':-.7,'gazeY':-.6,'browLeft':-.2,'browRight':.6,'focus':.35},holdMs=2600),
   dict(channels={'gazeX':0,'gazeY':-.15,'browLeft':.75,'browRight':.75,'smile':.7},holdMs=1900)]),
 'working':dict(channels={'focus':.4,'browInnerLeft':.45,'browInnerRight':.45,'work':1},variants=[
   dict(channels={'gazeX':-.6,'gazeY':.1,'focus':.5},holdMs=1500),
   dict(channels={'gazeX':.6,'gazeY':.1,'focus':.65},holdMs=1800),
   dict(channels={'gazeX':.1,'gazeY':-.6,'browLeft':.2,'focus':.3},holdMs=2000)]),
 'speaking':dict(channels={'smile':.2,'mouthOpen':.2}),
 'error':dict(channels={'error':1,'browInnerLeft':-.6,'browInnerRight':-.6}),
}
pack=dict(version=1,renderer='vector-face-v1',id='expressive-face',name='Expressive Face',
 colors=dict(idle='#27272a',standby='#27272a',connecting='#52525b',listening='#10b981',thinking='#f59e0b',working='#f97316',speaking='#8b5cf6',error='#dc2626'),
 ink=dict(features='#fff8e8',pupils='#33281f'),motion=dict(yaw=10,pitch=6,roll=7),artwork=dict(viewBox='0 0 100 100',nodes=nodes),
 rig=dict(leftEye=dict(outline='eye-left',pupils=['pupil-left','catchlight-a-left','catchlight-b-left']),
 rightEye=dict(outline='eye-right',pupils=['pupil-right','catchlight-a-right','catchlight-b-right']),
 brows=dict(left='brow-left',right='brow-right'),mouth=dict(outline='mouth',tongue='tongue')),poses=poses)
def write(name,value): (OUT/name).write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
(ROOT/'contract/expressive-face.json').write_text(json.dumps(pack,indent=2)+'\n',encoding='utf-8')
template=copy.deepcopy(pack); template.update(id='my-expressive-face',name='My Expressive Face')
write('my-expressive-face.orb.json',template)
# Second character: a different silhouette, angular eyelids, mechanical nose,
# inset brow panels, shaded shell. Same renderer, rig and voice controls.
robot=copy.deepcopy(template); robot.update(id='copper-companion',name='Copper Companion')
robot['ink']=dict(features='#fff1d6',pupils='#102530')
robot['resources']=dict(gradients=[dict(id='shell',kind='radial',cx=42,cy=38,r=65,fx=32,fy=25,
 stops=[dict(offset=0,color='#f7c487'),dict(offset=.55,color='#b86639'),dict(offset=1,color='#392b38')])])
for node in robot['artwork']['nodes']:
    if node['id']=='head':
        node['geometry']=path(['M',25,8],['Q',50,0,75,8],['Q',94,22,92,53],['Q',94,78,72,89],['Q',50,98,28,89],['Q',6,78,8,53],['Q',6,22,25,8],['Z'])
        node['fill']='@gradient:shell'; node['stroke']='$state';node['strokeWidth']=4
    if node['id'].startswith('eye-'):
        cx=32 if node['id']=='eye-left' else 69
        def robot_eye(upper,lower):
            return path(['M',cx-11,46],['C',cx-11,46-upper,cx-8,46-upper,cx,46-upper],
              ['C',cx+8,46-upper,cx+11,46-upper,cx+11,46],
              ['C',cx+11,46+lower,cx+8,46+lower,cx,46+lower],
              ['C',cx-8,46+lower,cx-11,46+lower,cx-11,46],['Z'])
        node['geometry']=robot_eye(7,7)
        node['morphs']={('blinkLeft' if cx==32 else 'blinkRight'):robot_eye(.4,.4),'sleep':robot_eye(-2,2.8),'focus':robot_eye(3,4)}
    if node['id']=='nose': node['geometry']=path(['M',47,54],['L',53,54],['L',53,59],['L',47,59],['Z'])
robot['artwork']['nodes'].insert(1,dict(id='shell-highlight',layer='body',geometry=path(['M',24,14],['Q',48,7,74,14]),fill='none',stroke='#ffe6bd',strokeWidth=2,opacity=.6))
write('copper-companion.orb.json',robot)
print('Wrote Expressive Face and two portable vector examples.')
