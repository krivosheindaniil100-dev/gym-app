#!/usr/bin/env python3
"""
Builds the realistic human asset for the app from MakeHuman CC0 data.

Sources (MakeHuman assets are released under CC0 since 2020):
  * base mesh:  makehuman/data/3dobjs/base.obj  (github makehumancommunity/makehuman)
  * targets:    makehuman/data/targets.npz      (PyPI wheel makehuman-1.3.2)

Output:
  public/human/human.bin   – positions, faces, targets (int16, scale 1e-3 decimetre)
  public/human/human.json  – layout + target table

Usage:  python3 tools/build_human.py <base.obj> <makehuman.whl>
"""
import io
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / 'public' / 'human'

# groups of the base mesh we render
KEEP_GROUPS = ['body', 'helper-l-eye', 'helper-r-eye', 'helper-hair', 'helper-l-eyelashes-1', 'helper-l-eyelashes-2', 'helper-r-eyelashes-1', 'helper-r-eyelashes-2']


def want(name: str) -> bool:
    n = name[len('targets/'):]
    cat = n.split('/')[0]
    leaf = n.split('/')[-1]
    if cat == 'macrodetails':
        if leaf.startswith('universal-'):
            return re.match(r'universal-(female|male)-(young|old)-(min|average|max)muscle-(min|average|max)weight$', leaf) is not None
        if '/' not in n[len('macrodetails/'):]:
            return re.match(r'(african|asian|caucasian)-(female|male)-(young|old)$', leaf) is not None
        return False  # height / proportions: we scale to the real height instead
    if cat == 'breast':
        if leaf.startswith('female-young-'):
            return re.match(r'female-young-(min|average|max)muscle-(min|average|max)weight-(min|max)cup-averagefirmness$', leaf) is not None
        return leaf.startswith('breast-')
    if cat in ('measure', 'stomach', 'buttocks', 'hip', 'torso', 'neck', 'pelvis', 'bodyshapes'):
        return not leaf.startswith('bulge')
    if cat == 'armslegs':
        return re.search(r'(upperarm|lowerarm|upperleg|lowerleg)-(fat|muscle|shoulder-muscle)', leaf) is not None
    if cat in ('eyes', 'nose', 'mouth', 'chin', 'cheek', 'head', 'forehead', 'eyebrows'):
        return True
    if cat == 'ears':
        return re.search(r'ear-(scale|trans|rot|lobe|flap|wing)', leaf) is not None
    return False


def main(base_obj: str, wheel: str):
    OUT.mkdir(parents=True, exist_ok=True)
    verts = []
    faces = {g: [] for g in KEEP_GROUPS}
    cur = None
    for line in open(base_obj, encoding='utf-8'):
        if line.startswith('v '):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('g '):
            cur = line[2:].strip()
        elif line.startswith('f ') and cur in faces:
            idx = [int(p.split('/')[0]) - 1 for p in line.split()[1:]]
            if len(idx) == 4:
                faces[cur].append(idx)
            elif len(idx) == 3:
                faces[cur].append(idx + [idx[2]])
    V = np.asarray(verts, dtype=np.float32)
    print('verts', V.shape, {g: len(f) for g, f in faces.items()})
    body_idx = np.unique(np.asarray(faces['body']).ravel())
    bmin = V[body_idx].min(0)
    bmax = V[body_idx].max(0)
    print('body bbox', bmin, bmax)

    z = zipfile.ZipFile(wheel)
    npz = np.load(io.BytesIO(z.read('makehuman/data/targets.npz')), allow_pickle=False)
    names = sorted(set(k.rsplit('.', 1)[0] for k in npz.files if k.endswith('.index')))
    sel = [n for n in names if want(n)]

    blob = io.BytesIO()

    def align(n=4):
        pad = (-blob.tell()) % n
        blob.write(b'\0' * pad)

    layout = {}
    align()
    layout['positions'] = [blob.tell(), int(V.shape[0])]
    blob.write(V.astype('<f4').tobytes())
    layout['faces'] = {}
    for g, fl in faces.items():
        if not fl:
            continue
        arr = np.asarray(fl, dtype='<u2')
        align()
        layout['faces'][g] = [blob.tell(), int(arr.shape[0])]
        blob.write(arr.tobytes())

    tlist = []
    total = 0
    for n in sel:
        idx = npz[n + '.index'].astype('<u2')
        vec = npz[n + '.vector'].astype('<i2')
        if idx.shape[0] == 0:
            continue
        # drop vertices we never render (teeth, tongue, genital helper…) to save space
        align()
        off = blob.tell()
        blob.write(idx.tobytes())
        align()
        off2 = blob.tell()
        blob.write(vec.tobytes())
        tlist.append({'name': n[len('targets/'):], 'idx': off, 'vec': off2, 'n': int(idx.shape[0])})
        total += idx.shape[0]
    data = blob.getvalue()
    (OUT / 'human.bin').write_bytes(data)
    meta = {
        'source': 'MakeHuman 1.x base mesh and targets (CC0 since 2020), makehumancommunity.org',
        'unit': 'decimetre',
        'vectorScale': 1e-3,
        'bboxMin': bmin.tolist(),
        'bboxMax': bmax.tolist(),
        'layout': layout,
        'targets': tlist,
    }
    (OUT / 'human.json').write_text(json.dumps(meta, separators=(',', ':')))
    print('targets', len(tlist), 'entries', total, 'bin MB', round(len(data) / 1e6, 2))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
