import json,re,sys
t=open('doc-view2.xml',encoding='utf-8').read()
j=json.loads(t[t.index('{"verdict"'):])
x=j['data']['xml']
open('doc2.xml','w',encoding='utf-8').write(x)
import xml.etree.ElementTree as ET
root=ET.fromstring(x)
def txt(e): return ''.join(e.itertext())
for i,b in enumerate(root):
    s=txt(b)
    print(i,b.tag,b.get('id'),b.get('h'),b.get('heading') or '',s[:90].replace('\n',' '))
