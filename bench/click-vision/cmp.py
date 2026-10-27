import json,sys,collections
def load(d):
    P={i['id']:i for i in json.load(open(d+'/prepared.json'))}
    rows=[json.loads(l) for l in open(d+'/raw.jsonl')]
    res=collections.defaultdict(lambda: collections.defaultdict(list))
    for x in rows:
        if x['item']=='shop-cookie' or x['arm'] not in 'CD': continue
        ok = 'error' not in x and int(x['choice'])==x['target']
        res[x['arm']][P[x['item']]['cat']].append(ok); res[x['arm']]['ALL'].append(ok)
        if not ok: res[x['arm']]['miss'].append(x['item'])
    return res
for d in sys.argv[1:]:
    r=load(d); print(d)
    for a in 'CD':
        print(' ',a, f"{sum(r[a]['ALL'])/len(r[a]['ALL']):.3f} n={len(r[a]['ALL'])}", {c:f"{sum(v)/len(v):.2f}" for c,v in r[a].items() if c not in('ALL','miss') and sum(v)/len(v)<1}, sorted(set(r[a]['miss'])))
