import json, re, sys
from xml.etree import ElementTree as ET

ns = {'s': 'https://www.larkoffice.com/sml/2.0'}

def text_of(el):
    parts = []
    for p in el.iter():
        if p.tag.endswith('}p') or p.tag.endswith('span'):
            if p.text:
                parts.append(p.text)
    return ''.join(parts)

for fn in ['.ppt_work/raw_5_8.json']:
    data = json.load(open(fn, encoding='utf-8-sig'))
    for sl in data['slides']:
        print('='*70)
        print(f"PAGE {sl['index']}  id={sl['slide_id']}")
        root = ET.fromstring(sl['raw_xml'])
        for d in root.iter():
            tag = d.tag.split('}')[-1]
            if tag in ('shape', 'img', 'table'):
                x = d.get('topLeftX'); y = d.get('topLeftY')
                w = d.get('width'); h = d.get('height')
                st = d.get('type', '')
                src = d.get('src', '')
                txt = text_of(d)[:120].replace('\n',' ')
                print(f"  <{tag} {st} id={d.get('id')} x={x} y={y} w={w} h={h} src={src}>")
                if txt.strip():
                    print(f"      TXT: {txt}")
