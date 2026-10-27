import os
DD=os.environ.get('CV_DATA','data')
import json,collections,statistics as st
P={i['id']:i for i in json.load(open(DD+'/prepared.json'))}
GW=80
def cell_to_idx(cell,it):
    c=ord(cell[0])-65; r=int(cell[1:])-1
    x0,y0,x1,y1=c*GW,r*GW,(c+1)*GW,(r+1)*GW
    best=None;ba=0
    for k,v in it['rects'].items():
        if not any(e['index']==int(k) and e.get('ops') for e in it['snap']['elements']): continue
        ix=max(0,min(x1,v['x']+v['w'])-max(x0,v['x']));iy=max(0,min(y1,v['y']+v['h'])-max(y0,v['y']));a=ix*iy
        if a>ba: ba=a;best=int(k)
    return best
rows=[json.loads(l) for l in open(DD+'/raw.jsonl')]
PR={'A':0.042,'B':0.10,'C':0.10,'D':0.10,'E':0.10}
for x in rows:
    x['ok']=None
    if 'error' in x: continue
    it=P[x['item']]
    ch=cell_to_idx(x['choice'],it) if x['arm']=='E' else int(x['choice'])
    x['ok']= ch==x['target']
rows=[x for x in rows if x['item']!='shop-cookie']
names={'A':'A Jev+tree','B':'B Luna+tree','C':'C Luna+marks','D':'D Luna+marks+tree','E':'E Luna+grid'}
def pct(a,p): a=sorted(a); return a[min(len(a)-1,int(len(a)*p))]
out=[];out.append('| arm | n | top-1 | errors | p50 ms | p90 ms | avg in-tok | payload KB | $/call | $/1000 | $/correct | acc conf>=0.6 (n) | acc conf<0.6 (n) |');out.append('|'+'---|'*13)
cats=sorted({x['cat'] for x in rows}); bycat={}
for arm in 'ABCDE':
    R=[x for x in rows if x['arm']==arm]; ok=[x for x in R if x['ok'] is not None]; acc=sum(x['ok'] for x in ok)/len(R)  # errors count wrong
    ms=[x['ms'] for x in R]; tok=[x['usage']['input_tokens'] for x in ok]; avg=st.mean(tok); cpc=avg*PR[arm]/1e6
    hi=[x for x in ok if x['confidence']>=0.6]; lo=[x for x in ok if x['confidence']<0.6]
    f=lambda L:(f"{sum(x['ok'] for x in L)/len(L):.2f} ({len(L)})" if L else 'n/a (0)')
    out.append(f"| {names[arm]} | {len(R)} | {acc:.3f} | {len(R)-len(ok)} | {pct(ms,.5)} | {pct(ms,.9)} | {avg:.0f} | {st.mean(x['payloadBytes'] for x in R)/1024:.1f} | {cpc:.6f} | {cpc*1000:.3f} | {cpc/acc:.6f} | {f(hi)} | {f(lo)} |")
    for c in cats:
        L=[x for x in R if x['cat']==c]; bycat.setdefault(c,{})[arm]=(sum(bool(x['ok']) for x in L)/len(L),len(L))
    # run-to-run consistency
out.append('\nBy category (accuracy, n calls per arm):\n');out.append('| category | n | '+' | '.join(names[a] for a in 'ABCDE')+' |');out.append('|'+'---|'*7)
for c in cats: out.append(f"| {c} | {bycat[c]['A'][1]} | "+' | '.join(f"{bycat[c][a][0]:.2f}" for a in 'ABCDE')+' |')
out.append('\nPer-item misses (item: arms wrong, of 2 runs each):')
for it in P:
    if it=='shop-cookie': continue
    w=collections.Counter(x['arm'] for x in rows if x['item']==it and not x['ok'])
    if w: out.append(f"- {it} [{P[it]['cat']}]: "+', '.join(f"{a}x{n}" for a,n in sorted(w.items())))
out.append('\nMean usage.cost reported: '+str({a:st.mean(x['usage'].get('cost',0) for x in rows if x['arm']==a and 'usage' in x) for a in 'ABCDE'}))
open(DD+'/tables.md','w').write('\n'.join(out)); print('\n'.join(out))
