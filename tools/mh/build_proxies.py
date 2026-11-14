#!/usr/bin/env python3
"""
Builds real hair / eyebrow / eyelash / eye geometry ("proxies") that follows every morph of the body.

Sources (official MakeHuman system assets, CC0 since 2020):
  * proxies:  makehuman-data (npm, MakeHuman 1.1 data as three.js legacy JSON): hair, eyebrows, eyelashes, eyes
  * base mesh: makehuman/data/3dobjs/base.obj (hm08, 19158 vertices incl. helpers)
  * targets:   makehuman/data/targets.npz inside the makehuman wheel (only used to rebuild the humans the proxies
               were authored on, see "scale" below)
  * weights:   default_weights.mhw (only used to tell how much each proxy vertex follows the head)

Output (deterministic):
  public/human/proxies.bin    geometry + fitting data, little-endian, int16/uint16/uint8 quantised
  public/human/proxies.json   layout, per-proxy metadata, render hints
  public/human/tex/*.webp     hair cards (grey + alpha, tint at runtime), brows/lashes (white + alpha), irises (RGB)

proxies.bin arrays per proxy (byte offsets in proxies.json, every array 4-byte aligned):
  ref  u16 x 3 x fitCount   base vertex indices of the reference triangle
  wgt  i16 x 2 x fitCount   barycentric w1, w2 / 4096 (w0 = 1 - w1 - w2)
  off  i16 x 3 x fitCount   offset / 20000 dm
  hw   u8  x fitCount       "headness" (255 = follows the head bone, 0 = follows the upper torso) for posed fitting
  dup  u16 x (vertexCount - fitCount)   canonical fit vertex of each uv-seam duplicate (render vertices = fit + dups)
  uv   u16 x 2 x vertexCount   uv / 65535 (v up)
  idx  u16 x 3 x triCount   triangles over the render vertices
  dir  i8  x 2 x vertexCount  (hair) strand direction in uv space from the structure tensor of the hair texture
  col  {n, idx u16 x n, ref u16 x 5 x n, clr u8 x n}  (hair) skin colliders of loose hair: fit vertex, skin vertex j and
       four ring neighbours a, b, c, d (normal = (a - c) x (b - d)), rest clearance / 500 dm on the authoring human

Fitting (MakeHuman shared/proxy.py, Proxy.getCoords):
  p = w0*V[r0] + w1*V[r1] + w2*V[r2] + M * offset,   M = diag(|V[a_n]-V[b_n]|_n / den_n), n = x, y, z
The JSON export dropped the x_scale / y_scale / z_scale lines of the .mhclo files (TMatrix), so they are re-derived:
  * reference vertices: MakeClothes' "Head" set  x: 5399-11998, y: 791-881, z: 962-5320 (the same triple appears in the
    two official .mhclo files that are available, eyes/high-poly and eyes/low-poly);
  * den: MakeClothes writes the extent of the human the proxy was modelled on, so that M = I on that human. That human
    is identified by reconstructing the stored OBJ vertices: objVertex - offset == sum(w * V_human[ref]). Candidates are
    the raw base mesh and the young / average macro humans; the best one is taken and its residual is stored in
    proxies.json (0.0000-0.012 dm for all shipped proxies). For the eyes the real numbers of the .mhclo are used.

Usage:  python3 tools/mh/build_proxies.py [--proxies DIR] [--base-obj OBJ] [--wheel WHL] [--weights MHW]
                                          [--eye-hires PNG] [--out DIR] [--only a,b,c] [--candidates]
"""
import argparse
import io
import json
import os
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SCRATCH = '/tmp/claude-0/-home-user-gym-app/7c91fb80-ada3-505f-ab80-0fc6e00e761f/scratchpad'
ROOT = Path(__file__).resolve().parent.parent.parent

N_BASE = 19158
BODY_VERTS = 13380  # vertices 0..13379 are the skin; the rest are helpers / joints
# MakeClothes "Head" scale references: (vertex a, vertex b, axis)
HEAD_REFS = ((5399, 11998, 0), (791, 881, 1), (962, 5320, 2))
# x_scale / y_scale / z_scale denominators of data/eyes/high-poly/high-poly.mhclo (MakeHuman master)
EYES_HIGHPOLY_DEN = (1.6482, 2.7213, 2.2795)
EYES_LOWPOLY_DEN = (1.7412, 2.7409, 2.2613)

W_SCALE = 4096  # barycentric weights w1, w2 as int16 / 4096 (w0 = 1 - w1 - w2)
OFF_SCALE = 20000  # offsets as int16 / 20000 decimetre (5 micrometre steps)
CLR_SCALE = 500  # collider rest clearance as uint8 / 500 decimetre (0.2 mm steps, max 5.1 cm)
COL_MARGIN, COL_SLOPE = 0.04, 0.25  # kept clearance = min(rest, COL_MARGIN + COL_SLOPE * rest)  [dm]
COL_MAX_DIST = 2.0  # hair further than 20 cm from the skin of the authoring human gets no collider

# ───────────────────────── asset selection ─────────────────────────
# name, kind, source folder, label, tags.  Only official MakeHuman system assets.
FINAL = [
    dict(name='eyes', kind='eyes', src='eyes/HighPolyEyes', label='Eyes'),
    dict(name='eyebrow001', kind='eyebrows', src='eyebrows/eyebrow001', label='Brows · natural'),
    dict(name='eyebrow010', kind='eyebrows', src='eyebrows/eyebrow010', label='Brows · thin arched'),
    dict(name='eyelashes02', kind='eyelashes', src='eyelashes/eyelashes02', label='Lashes'),
    dict(name='short02', kind='hair', src='hair/short02', label='Short'),
    dict(name='short04', kind='hair', src='hair/short04', label='Short · side part'),
    dict(name='ponytail01', kind='hair', src='hair/ponytail01', label='Ponytail'),
    dict(name='long01', kind='hair', src='hair/long01', label='Long'),
    dict(name='bob01', kind='hair', src='hair/bob01', label='Bob'),
]
CANDIDATES = FINAL + [
    dict(name='eyes_low', kind='eyes', src='eyes/Low-Poly', label='Eyes (low poly)'),
    dict(name='afro01', kind='hair', src='hair/afro01', label='Afro'),  # rejected: cards and white patches show
    *[dict(name='eyebrow%03d' % i, kind='eyebrows', src='eyebrows/eyebrow%03d' % i, label='Brows %d' % i) for i in range(1, 13) if i not in (1, 10)],
    dict(name='eyelashes01', kind='eyelashes', src='eyelashes/Eyelashes01', label='Lashes 1'),
    dict(name='eyelashes03', kind='eyelashes', src='eyelashes/eyelashes03', label='Lashes 3'),
    dict(name='eyelashes04', kind='eyelashes', src='eyelashes/eyelashes04', label='Lashes 4'),
    dict(name='short01', kind='hair', src='hair/short01', label='Short 1'),
    dict(name='short03', kind='hair', src='hair/short03', label='Short 3'),
    dict(name='bob02', kind='hair', src='hair/bob02', label='Bob 2'),
    dict(name='braid01', kind='hair', src='hair/Braid01', label='Braid'),
]
EYE_COLORS = ['brown', 'brownlight', 'blue', 'green', 'grey']

# three.js material recommendations per kind (documented in proxies.json so the viewer needs no magic numbers)
RENDER = {
    'hair': dict(
        side='double', transparent=False, alphaTest=0.5, alphaToCoverage=True, depthWrite=True, renderOrder=2, roughness=0.85,
        note='MSAA: alphaToCoverage + alphaTest 0.5. No MSAA: pass 1 opaque alphaTest 0.5 depthWrite; optional pass 2 '
             'transparent, depthWrite false, depthFunc LESS for soft strand tips. Multiply map by tint.'),
    'eyebrows': dict(
        side='front', transparent=True, alphaTest=0.02, depthWrite=False, renderOrder=3,
        polygonOffset=True, polygonOffsetFactor=-2, polygonOffsetUnits=-4,
        note='thin decal 1-3 mm above the skin: blended, no depth write, polygon offset against z-fighting'),
    'eyelashes': dict(
        side='double', transparent=True, alphaTest=0.02, depthWrite=False, renderOrder=4,
        note='blended, no depth write; draw after eyes, cornea and brows'),
    'eyes': dict(side='front', transparent=False, depthWrite=True, renderOrder=0, roughness=0.35, note='opaque eyeball, sRGB map, no tint'),
    'cornea': dict(
        side='front', transparent=True, blending='additive', color=[0, 0, 0], roughness=0.03, depthWrite=False, renderOrder=1,
        note='clear shell over iris and sclera: black base colour + additive blending leaves only specular / environment '
             'reflections (wet highlight). Needs a light or an environment map to be visible.'),
}


# ───────────────────────── inputs ─────────────────────────

def load_obj_verts(path):
    v = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('v '):
                v.append([float(x) for x in line.split()[1:4]])
    a = np.asarray(v, dtype=np.float64)
    assert a.shape == (N_BASE, 3), a.shape
    return a


def load_obj_skin_faces(path):
    """Faces of the base OBJ that only use skin vertices (index < BODY_VERTS)."""
    faces = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('f '):
                ids = [int(t.split('/')[0]) - 1 for t in line.split()[1:]]
                if max(ids) < BODY_VERTS:
                    faces.append(ids)
    return faces


def skin_rings(faces, v):
    """Per skin vertex j four one-ring neighbours (a, b, c, d) with cross(V[a]-V[c], V[b]-V[d]) = outward normal
    (central differences across the ring: cheap to evaluate at runtime on the morphed / posed mesh).
    Returns (rings (BODY_VERTS, 4), valid mask)."""
    nxt = [dict() for _ in range(BODY_VERTS)]
    nrm = np.zeros((BODY_VERTS, 3))
    for f in faces:
        n = len(f)
        fn = np.cross(v[f[2]] - v[f[0]], v[f[3 % n]] - v[f[1]]) if n == 4 else np.cross(v[f[1]] - v[f[0]], v[f[2]] - v[f[0]])
        for k in range(n):
            nxt[f[k]][f[(k - 1) % n]] = f[(k + 1) % n]
            nrm[f[k]] += fn
    rings = np.zeros((BODY_VERTS, 4), dtype=np.int64)
    ok = np.zeros(BODY_VERTS, dtype=bool)
    for j in range(BODY_VERTS):
        m = nxt[j]
        if len(m) < 3:
            continue
        start = next(iter(m))
        ring, cur = [start], m.get(start)
        while cur is not None and cur != start and len(ring) <= len(m):
            ring.append(cur)
            cur = m.get(cur)
        if cur != start:
            continue  # open fan (mesh border)
        n = len(ring)
        r = [ring[0], ring[1], ring[2], ring[0]] if n == 3 else [ring[0], ring[n // 4], ring[n // 2], ring[(3 * n) // 4]]
        if np.dot(np.cross(v[r[0]] - v[r[2]], v[r[1]] - v[r[3]]), nrm[j]) < 0:
            r = [r[0], r[3], r[2], r[1]]
        rings[j] = r
        ok[j] = True
    return rings, ok


def hair_colliders(p, cand, skin, rings, ring_ok):
    """Skin colliders for loose hair. p: hair vertices on the authoring human (collision free by design), cand: mask of
    vertices that may collide. For each one the nearest skin vertex j and its ring give a tangent plane; the signed
    rest clearance above that plane is stored. Returns (hair vertex index, [j, a, b, c, d], clearance in dm)."""
    sel = np.where(ring_ok & (skin[:BODY_VERTS, 1] > p[:, 1].min() - 1.0))[0]
    S = skin[sel]
    ids = np.where(cand)[0]
    jj = np.zeros(len(ids), dtype=np.int64)
    dd = np.zeros(len(ids))
    for i in range(0, len(ids), 256):
        d = np.linalg.norm(p[ids[i:i + 256], None, :] - S[None], axis=2)
        k = d.argmin(1)
        jj[i:i + 256] = sel[k]
        dd[i:i + 256] = d[np.arange(len(k)), k]
    r = rings[jj]
    n = np.cross(skin[r[:, 0]] - skin[r[:, 2]], skin[r[:, 1]] - skin[r[:, 3]])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    c = ((p[ids] - skin[jj]) * n).sum(1)
    keep = (dd <= COL_MAX_DIST) & (c >= 0)
    return ids[keep], np.concatenate([jj[keep, None], r[keep]], axis=1), c[keep]


def parse_faces(faces, n_uv_layers):
    """three.js legacy JSON (format 3.x) face stream → list of (vertex indices, uv indices)."""
    out = []
    i, n = 0, len(faces)
    while i < n:
        t = faces[i]
        i += 1
        nv = 4 if t & 1 else 3
        v = faces[i:i + nv]
        i += nv
        if t & 2:  # material index
            i += 1
        if t & 4:  # face uv (deprecated)
            i += n_uv_layers
        uv = None
        if t & 8:  # face-vertex uvs
            for layer in range(n_uv_layers):
                if layer == 0:
                    uv = faces[i:i + nv]
                i += nv
        if t & 16:  # face normal
            i += 1
        if t & 32:  # face-vertex normals
            i += nv
        if t & 64:  # face colour
            i += 1
        if t & 128:  # face-vertex colours
            i += nv
        out.append((v, uv))
    assert i == n, 'face stream not consumed exactly'
    return out


def load_proxy_json(path):
    j = json.load(open(path, encoding='utf-8'))
    n_uv = max(1, len(j['uvs']))
    return dict(
        ref=np.asarray(j['ref_vIdxs'], dtype=np.int64),
        w=np.asarray(j['weights'], dtype=np.float64),
        off=np.asarray(j['offsets'], dtype=np.float64),
        uv=np.asarray(j['uvs'][0], dtype=np.float64).reshape(-1, 2),
        faces=parse_faces(j['faces'], n_uv),
        objv=np.asarray(j['vertices'], dtype=np.float64).reshape(-1, 3),
        skin_i=np.asarray(j['skinIndices'], dtype=np.int64).reshape(-1, j['influencesPerVertex']),
        skin_w=np.asarray(j['skinWeights'], dtype=np.float64).reshape(-1, j['influencesPerVertex']),
        bones=[b['name'] for b in j['bones']],
        delete=np.asarray(j['metadata']['deleteVerts'], dtype=bool),
        z_depth=j['metadata'].get('z_depth'),
        tags=j['metadata'].get('tags', []),
        mats=j['materials'],
    )


class Targets:
    def __init__(self, wheel):
        z = zipfile.ZipFile(wheel)
        self.npz = np.load(io.BytesIO(z.read('makehuman/data/targets.npz')), allow_pickle=False)

    def apply(self, base, weights):
        p = base.copy()
        for name, w in weights.items():
            idx = self.npz['targets/' + name + '.index']
            vec = self.npz['targets/' + name + '.vector'].astype(np.float64) * 1e-3
            p[idx] += w * vec
        return p


def authoring_humans(base, targets):
    """Humans MakeHuman's artists modelled proxies on: raw base mesh and young / average macro humans."""
    out = {'base': base}
    for gname, g in (('female', 0.0), ('neutral', 0.5), ('male', 1.0)):
        for ename, eth in (('caucasian', (0, 0, 1)), ('mixed', (1 / 3, 1 / 3, 1 / 3))):
            w = {}
            for sex, sv in (('male', g), ('female', 1 - g)):
                if sv <= 0:
                    continue
                w['macrodetails/universal-%s-young-averagemuscle-averageweight' % sex] = sv
                for e, ev in zip(('african', 'asian', 'caucasian'), eth):
                    if ev > 0:
                        w['macrodetails/%s-%s-young' % (e, sex)] = sv * ev
            out['%s-%s' % (gname, ename)] = targets.apply(base, w)
    return out


def head_extents(v):
    return np.array([abs(v[a][n] - v[b][n]) for a, b, n in HEAD_REFS])


def load_weights(path, bones_parent):
    """default_weights.mhw → per base vertex 'headness' (0 = follows the torso, 1 = follows the head bone)."""
    data = json.load(open(path, encoding='utf-8'))['weights']

    def under_head(b):
        while b:
            if b == 'head':
                return True
            b = bones_parent.get(b)
        return False

    total = np.zeros(N_BASE)
    head = np.zeros(N_BASE)
    wh = np.zeros(N_BASE)  # weight of the head bone family only (for anchor selection)
    wt = np.zeros(N_BASE)  # weight of the upper torso
    for bone, lst in data.items():
        a = np.asarray(lst, dtype=np.float64)
        idx = a[:, 0].astype(np.int64)
        total[idx] += a[:, 1]
        # a neck chain that shares a head rotation gives the lower neck bones a fraction of it
        alpha = 1.0 if under_head(bone) else {'neck03': 0.6, 'neck02': 0.4, 'neck01': 0.2}.get(bone, 0.0)
        head[idx] += a[:, 1] * alpha
        if bone == 'head':
            wh[idx] += a[:, 1]
        if bone in ('spine01', 'spine02', 'clavicle.L', 'clavicle.R'):
            wt[idx] += a[:, 1]
    total = np.maximum(total, 1e-9)
    return head / total, wh / total, wt / total


def pick_anchor(base, mask, n):
    """Deterministic, well spread subset (farthest point sampling) of the masked body vertices."""
    cand = np.where(mask)[0]
    pts = base[cand]
    chosen = [int(np.argmin(pts[:, 1] * 1e3 + pts[:, 0]))]
    d = np.linalg.norm(pts - pts[chosen[0]], axis=1)
    while len(chosen) < min(n, len(cand)):
        k = int(np.argmax(d))
        chosen.append(k)
        d = np.minimum(d, np.linalg.norm(pts - pts[k], axis=1))
    return sorted(int(cand[k]) for k in chosen)


# ───────────────────────── textures ─────────────────────────

def srgb_to_linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255.0


def dilate_fill(val, known, passes=48):
    """Bleeds known texels into unknown ones so that bilinear / mip filtering never mixes in garbage colours."""
    val = val.astype(np.float64).copy()
    known = known.copy()
    for _ in range(passes):
        if known.all():
            break
        acc = np.zeros_like(val)
        cnt = np.zeros(val.shape, dtype=np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                acc += np.roll(np.roll(val * known, dy, 0), dx, 1)
                cnt += np.roll(np.roll(known, dy, 0), dx, 1)
        new = (~known) & (cnt > 0)
        val[new] = acc[new] / cnt[new]
        known = known | new
    if not known.all():
        val[~known] = val[known].mean() if known.any() else 0
    return val


def save_webp(img, path, quality, alpha_quality=100, lossless=False):
    img.save(path, 'WEBP', quality=quality, alpha_quality=alpha_quality, method=6, exact=True, lossless=lossless)
    return os.path.getsize(path)


def hair_texture(src, dst, size, quality):
    """RGBA hair cards → luminance-normalised grey + alpha. Returns (bytes, tint in linear RGB, alpha coverage)."""
    im = Image.open(src).convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float64)
    alpha = a[:, :, 3] / 255.0
    lin = srgb_to_linear(a[:, :, :3])
    lum = lin @ np.array([0.2126, 0.7152, 0.0722])
    solid = alpha > 0.5
    white = np.percentile(lum[solid], 98.0)
    grey = np.clip(lum / white, 0, 1)
    wsum = alpha.sum()
    # tint that reproduces the artist's colour: sum(lin * a) == tint * sum(grey * a)
    tint = (lin * alpha[:, :, None]).sum((0, 1)) / max((grey * alpha).sum(), 1e-9)
    tint = np.clip(tint, 0, 1)
    g8 = linear_to_srgb(dilate_fill(grey, alpha > 0.02))
    out = np.zeros((size, size, 4), dtype=np.uint8)
    out[:, :, 0] = out[:, :, 1] = out[:, :, 2] = np.clip(np.round(g8), 0, 255).astype(np.uint8)
    out[:, :, 3] = feather_alpha(a[:, :, 3], size)
    n = save_webp(Image.fromarray(out, 'RGBA'), dst, quality, alpha_quality=90)
    return n, tint, float(wsum / alpha.size), strand_tensor(g8 / 255.0, alpha)


def feather_alpha(alpha8, size):
    """Soft card edges: the viewer breaks the 0.5 contour into strands and blends the feather in a second pass."""
    # dilate first, then blur: solid texels stay solid (cards that meet at a parting keep meeting), the feather grows outwards
    im = Image.fromarray(np.asarray(alpha8).astype(np.uint8), 'L')
    k = max(1, round(size / 512 * 3))
    return np.asarray(im.filter(ImageFilter.MaxFilter(2 * k + 1)).filter(ImageFilter.GaussianBlur(radius=k)))


def box_blur(a, r, passes=3):
    """Separable box blur (three passes ~ Gaussian), edge clamped."""
    n = 2 * r + 1
    for _ in range(passes):
        for ax in (0, 1):
            pad = [(r + 1, r) if i == ax else (0, 0) for i in range(2)]
            c = np.cumsum(np.pad(a, pad, mode='edge'), axis=ax)
            m = a.shape[ax]
            a = (np.take(c, np.arange(n, n + m), axis=ax) - np.take(c, np.arange(0, m), axis=ax)) / n
    return a


def strand_tensor(grey, alpha, radius=5):
    """Smoothed structure tensor (Jxx, Jxy, Jyy; image space, y down) of the painted strands. Strands run along the
    eigenvector of the SMALLER eigenvalue (brightness changes across strands, not along them)."""
    gy, gx = np.gradient(grey)
    return np.stack([box_blur(alpha * gx * gx, radius), box_blur(alpha * gx * gy, radius), box_blur(alpha * gy * gy, radius)], axis=-1)


def strand_dirs(tensor, uvs, tris):
    """Strand direction in uv space (v up) per render vertex as int8 (unit length = 127, sign arbitrary; 0,0 = unknown).
    The tensor is sampled at the vertex and at the centroids of its triangles (keeps samples inside the uv island)."""
    size = tensor.shape[0]

    def sample(uv):
        x = np.clip(np.floor(uv[:, 0] * size).astype(np.int64), 0, size - 1)
        y = np.clip(np.floor((1 - uv[:, 1]) * size).astype(np.int64), 0, size - 1)
        return tensor[y, x]

    acc = sample(uvs)
    cen = sample(uvs[tris].mean(1))
    for k in range(3):
        np.add.at(acc, tris[:, k], 2 * cen)
    jxx, jxy, jyy = acc[:, 0], acc[:, 1], acc[:, 2]
    phi = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2  # strand angle in the image
    coherence = np.hypot(jxx - jyy, 2 * jxy) / np.maximum(jxx + jyy, 1e-12)
    d = np.stack([np.cos(phi), -np.sin(phi)], axis=1)  # image y down → v up
    d[(coherence < 0.15) | (jxx + jyy < 1e-9)] = 0
    return np.round(d * 127).astype(np.int8), float((coherence >= 0.15).mean())


def stroke_texture(src, dst, size, alpha_quality=90):
    """Brows / lashes: dark strokes on transparent → white RGB + alpha (colour comes from the material tint)."""
    im = Image.open(src).convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float64)
    alpha = a[:, :, 3] / 255.0
    lin = srgb_to_linear(a[:, :, :3])
    tint = (lin * alpha[:, :, None]).sum((0, 1)) / max(alpha.sum(), 1e-9)
    out = np.full((size, size, 4), 255, dtype=np.uint8)
    out[:, :, 3] = a[:, :, 3].astype(np.uint8)
    n = save_webp(Image.fromarray(out, 'RGBA'), dst, 80, alpha_quality=alpha_quality)
    return n, np.clip(tint, 0, 1), float(alpha.mean())


def find_pupil(im):
    """Pupil centre (u, v with v up) of the lower-left eye disc of a MakeHuman eye texture."""
    a = np.asarray(im.convert('RGBA')).astype(np.float64)
    h, w = a.shape[:2]
    lum = a[:, :, :3] @ np.array([0.299, 0.587, 0.114])
    y, x = np.mgrid[0:h, 0:w]
    u = (x + 0.5) / w
    v = 1 - (y + 0.5) / h
    region = (np.hypot(u - 0.29, v - 0.29) < 0.08) & (a[:, :, 3] > 128)
    thr = np.percentile(lum[region], 5) + 10
    m = region & (lum < thr)
    return float(u[m].mean()), float(v[m].mean())


EYE_CROP_HALF = 0.285  # half size (uv) of the square cut around the pupil; the uv island radius is 0.267


def eye_texture(src, dst, size, quality, hue_shift_deg=0.0, sat_scale=1.0):
    """Square cut around the pupil. hue_shift_deg / sat_scale recolour the iris only (saturated texels near the pupil):
    MakeHuman's "brown" iris is a blood red-brown (hue 10 deg, saturation 0.95) that reads as red eyes when lit."""
    im = Image.open(src).convert('RGB')
    pu, pv = find_pupil(Image.open(src))
    w = im.size[0]
    box = ((pu - EYE_CROP_HALF) * w, (1 - pv - EYE_CROP_HALF) * w, (pu + EYE_CROP_HALF) * w, (1 - pv + EYE_CROP_HALF) * w)
    crop = im.resize((size, size), Image.LANCZOS, box=box)
    if hue_shift_deg or sat_scale != 1.0:
        hsv = np.asarray(crop.convert('HSV')).astype(np.float64)
        y, x = np.mgrid[0:size, 0:size]
        r = np.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5)
        k = np.clip((0.30 - r) / 0.05, 0, 1) * np.clip((hsv[:, :, 1] / 255.0 - 0.35) / 0.25, 0, 1)  # iris weight
        hsv[:, :, 0] = (hsv[:, :, 0] + k * hue_shift_deg * 255.0 / 360.0) % 256
        hsv[:, :, 1] *= 1 - k * (1 - sat_scale)
        crop = Image.fromarray(np.clip(np.round(hsv), 0, 255).astype(np.uint8), 'HSV').convert('RGB')
    return save_webp(crop, dst, quality), (pu, pv)


# ───────────────────────── geometry ─────────────────────────

class Blob:
    def __init__(self):
        self.b = io.BytesIO()

    def add(self, arr):
        pad = (-self.b.tell()) % 4
        self.b.write(b'\0' * pad)
        off = self.b.tell()
        self.b.write(np.ascontiguousarray(arr).tobytes())
        return off


def split_components(n_verts, faces):
    parent = list(range(n_verts))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for v, _ in faces:
        for x in v[1:]:
            a, b = find(v[0]), find(x)
            if a != b:
                parent[max(a, b)] = min(a, b)
    return np.array([find(i) for i in range(n_verts)])


def build_mesh(p, faces, uv_of_face_vertex):
    """Welds (fit vertex, uv) pairs into render vertices.

    Render vertex order: [one canonical vertex per used fit vertex][uv-seam duplicates], so the runtime writes the
    fitted positions straight into the output and only copies the few duplicates.
    Returns (fit vertex ids in order, dup → canonical index, uv per render vertex, triangles)."""
    used = []
    seen = {}
    for v, _ in faces:
        for a in v:
            if a not in seen:
                seen[a] = len(used)
                used.append(a)
    canon_uv = {}
    dup = []  # canonical index of each duplicate
    dup_uv = []
    key2idx = {}
    tris = []
    n_fit = len(used)
    for fi, (v, uv) in enumerate(faces):
        ids = []
        for k, a in enumerate(v):
            c = seen[a]
            t = uv_of_face_vertex(fi, k)
            key = (c, round(t[0], 6), round(t[1], 6))
            r = key2idx.get(key)
            if r is None:
                if c not in canon_uv:
                    canon_uv[c] = t
                    r = c
                else:
                    r = n_fit + len(dup)
                    dup.append(c)
                    dup_uv.append(t)
                key2idx[key] = r
            ids.append(r)
        if len(ids) == 4:
            # split along the shorter diagonal (better shaped triangles on curved cards)
            q = [p[x] for x in v]
            if np.linalg.norm(q[0] - q[2]) <= np.linalg.norm(q[1] - q[3]):
                tris += [[ids[0], ids[1], ids[2]], [ids[0], ids[2], ids[3]]]
            else:
                tris += [[ids[0], ids[1], ids[3]], [ids[1], ids[2], ids[3]]]
        else:
            tris.append(ids)
    uvs = np.array([canon_uv[c] for c in range(n_fit)] + dup_uv, dtype=np.float64).reshape(-1, 2)
    return np.array(used), np.array(dup, dtype=np.int64), uvs, np.array(tris, dtype=np.int64)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--proxies', default=SCRATCH + '/mhdata/x/package/public/data/proxies')
    ap.add_argument('--base-obj', default=SCRATCH + '/mh_raw/makehuman_data_3dobjs_base.obj')
    ap.add_argument('--wheel', default=SCRATCH + '/mh_dl/mh.whl')
    ap.add_argument('--weights', default=SCRATCH + '/mh_raw/default_weights.mhw')
    ap.add_argument('--rig', default=SCRATCH + '/mhdata/x/package/src/json/rigs/default.json')
    ap.add_argument('--eye-hires', default=SCRATCH + '/rnd/proxies/dl/eyes_materials_brown_eye.png',
                    help='optional 1024 px brown_eye.png of MakeHuman master (sharper default iris); skipped if missing')
    ap.add_argument('--out', default=str(ROOT / 'public' / 'human'))
    ap.add_argument('--only', default='', help='comma separated proxy names')
    ap.add_argument('--candidates', action='store_true', help='also build every official candidate (evaluation only)')
    args = ap.parse_args()

    out_dir = Path(args.out)
    tex_dir = out_dir / 'tex'
    tex_dir.mkdir(parents=True, exist_ok=True)

    base = load_obj_verts(args.base_obj)
    targets = Targets(args.wheel)
    humans = authoring_humans(base, targets)
    rig = json.load(open(args.rig, encoding='utf-8'))
    parents = {b: d['parent'] for b, d in rig['bones'].items()}
    headness, w_head, w_torso = load_weights(args.weights, parents)

    rings, ring_ok = skin_rings(load_obj_skin_faces(args.base_obj), base)
    body = np.arange(N_BASE) < BODY_VERTS
    head_anchor = pick_anchor(base, body & (w_head > 0.999), 48)
    torso_anchor = pick_anchor(base, body & (w_torso > 0.9), 48)

    assets = CANDIDATES if args.candidates else FINAL
    if args.only:
        names = set(args.only.split(','))
        assets = [a for a in assets if a['name'] in names]

    blob = Blob()
    proxies = []
    tex_bytes = {}
    report = []

    def emit(name, kind, label, src, p_rest, ref, w, off, faces, uv_fn, den, hw, extra, orient=None, collide=None):
        used, dup, uvs, tris = build_mesh(p_rest, faces, uv_fn)
        n_fit, n_render = len(used), len(used) + len(dup)
        assert n_render < 65536
        ref_u, w_u, off_u = ref[used], w[used], off[used]
        assert np.abs(w_u.sum(1) - 1).max() < 2e-4, 'barycentric weights must sum to 1'
        wq = np.round(w_u[:, 1:] * W_SCALE)
        oq = np.round(off_u * OFF_SCALE)
        assert np.abs(wq).max() < 32768 and np.abs(oq).max() < 32768, 'quantisation overflow'
        # quantisation error against the float fit on the base mesh
        a0 = base[ref_u[:, 0]]
        fq = a0 + (wq[:, 0:1] / W_SCALE) * (base[ref_u[:, 1]] - a0) + (wq[:, 1:2] / W_SCALE) * (base[ref_u[:, 2]] - a0) + oq / OFF_SCALE
        ff = (base[ref_u] * w_u[:, :, None]).sum(1) + off_u
        qerr = float(np.abs(fq - ff).max())
        assert qerr < 2e-3, qerr
        entry = dict(
            name=name, kind=kind, label=label, source=src,
            fitCount=int(n_fit), vertexCount=int(n_render), triCount=int(len(tris)),
            ref=blob.add(ref_u.astype('<u2')),
            wgt=blob.add(wq.astype('<i2')),
            off=blob.add(oq.astype('<i2')),
            hw=blob.add(np.clip(np.round(hw[used] * 255), 0, 255).astype('u1')),
            dup=blob.add(dup.astype('<u2')),
            uv=blob.add(np.clip(np.round(uvs * 65535), 0, 65535).astype('<u2')),
            idx=blob.add(tris.astype('<u2')),
            scale=[[int(a), int(b), float(round(d, 5))] for (a, b, _), d in zip(HEAD_REFS, den)],
            render=RENDER[kind],
        )
        # reference for tests: plain MakeHuman fit (float64, no collision) on the raw base mesh
        pr = p_rest[used]
        entry['check'] = dict(centroid=[round(float(x), 5) for x in pr.mean(0)], min=[round(float(x), 5) for x in pr.min(0)],
                              max=[round(float(x), 5) for x in pr.max(0)])
        if orient is not None:
            dirs, known = strand_dirs(orient, uvs, tris)
            entry['dir'] = blob.add(dirs)
            entry['dirKnown'] = round(known, 3)
        if collide is not None:
            p_auth, cand, skin = collide
            ci, cref, cclr = hair_colliders(p_auth[used], cand[used], skin, rings, ring_ok)
            if len(ci):
                entry['col'] = dict(
                    n=int(len(ci)),
                    idx=blob.add(ci.astype('<u2')),
                    ref=blob.add(cref.astype('<u2')),
                    clr=blob.add(np.clip(np.round(cclr * CLR_SCALE), 0, 255).astype('u1')))
        entry.update(extra)
        proxies.append(entry)
        return entry, qerr

    for a in assets:
        kind, name = a['kind'], a['name']
        folder = Path(args.proxies) / a['src']
        d = load_proxy_json(folder / (folder.name + '.json'))
        ref, w, off = d['ref'], d['w'], d['off']
        assert ref.max() < N_BASE
        # ── which human was this proxy modelled on? (→ scale denominators)
        res = []
        for hn, hv in humans.items():
            r = d['objv'] - off - (hv[ref] * w[:, :, None]).sum(1)
            res.append((float(np.abs(r).mean()), float(np.abs(r).max()), hn))
        res.sort()
        if a['src'] == 'eyes/HighPolyEyes':
            den, auth = np.array(EYES_HIGHPOLY_DEN), dict(human='legacy (mhclo values)', residual=None)
        elif a['src'] == 'eyes/Low-Poly':
            den, auth = np.array(EYES_LOWPOLY_DEN), dict(human='legacy (mhclo values)', residual=None)
        else:
            den = head_extents(humans[res[0][2]])
            # residual of the stored OBJ vertices against the fit on the authoring human (euclidean, dm)
            eb = np.linalg.norm(d['objv'] - off - (humans[res[0][2]][ref] * w[:, :, None]).sum(1), axis=1)
            auth = dict(human=res[0][2], residual=round(res[0][0], 5), residualMedian=round(float(np.median(eb)), 5),
                        residualMax=round(float(eb.max()), 4), outliers=int((eb > 0.02).sum()))
        # rest shape on the base mesh (MakeHuman fit) – used for diagonal choice / statistics only
        m_base = head_extents(base) / den
        p_rest = (base[ref] * w[:, :, None]).sum(1) + off * m_base
        # ── how much each vertex follows the head when the base mesh is posed (from the proxy's own skin weights)
        bone_alpha = np.zeros(len(d['bones']))
        for bi, bn in enumerate(d['bones']):
            bn = bn.replace('____head', '')
            b, under = bn, False
            while b:
                if b == 'head':
                    under = True
                    break
                b = parents.get(b)
            bone_alpha[bi] = 1.0 if under else {'neck03': 0.6, 'neck02': 0.4, 'neck01': 0.2}.get(bn, 0.0)
        sw = d['skin_w'] / np.maximum(d['skin_w'].sum(1, keepdims=True), 1e-9)
        hw = (sw * bone_alpha[d['skin_i']]).sum(1)
        n_delete = int(d['delete'].sum())
        faces = d['faces']
        uv = d['uv']

        if kind == 'eyes':
            # eyeball + clear cornea shell; the cornea's uvs sit in the transparent corner patch of the texture
            comp = split_components(len(ref), faces)
            is_cornea_face = []
            for v, t in faces:
                c = uv[t].mean(0)
                is_cornea_face.append(bool(c[0] > 0.85 and c[1] < 0.15))
            ball_faces = [f for f, c in zip(faces, is_cornea_face) if not c]
            cornea_faces = [f for f, c in zip(faces, is_cornea_face) if c]
            # iris-centred uvs: the pupil of the cropped texture sits at (0.5, 0.5) and so does the pole of each eyeball
            new_uv = {}
            for cid in np.unique(comp):
                fs = [(v, t) for (v, t) in ball_faces if comp[v[0]] == cid]
                if not fs:
                    continue
                ids = sorted({x for _, t in fs for x in t})
                isl = uv[ids]
                centre = (isl.min(0) + isl.max(0)) / 2
                inner = isl[np.argsort(np.linalg.norm(isl - centre, axis=1))[:8]].mean(0)  # mesh pole
                verts = sorted({x for v, _ in fs for x in v})
                right = p_rest[verts][:, 0].mean() < 0
                for x in ids:
                    du, dv = uv[x] - inner
                    if right:
                        du = -du  # mirror: the right eye shows the mirror image of the left one
                    new_uv[(cid, x)] = (0.5 + du / (2 * EYE_CROP_HALF), 0.5 + dv / (2 * EYE_CROP_HALF))
            # left / right islands differ a little in scale; normalise both to the left one
            def ball_uv(fi, k, fs=ball_faces):
                v, t = fs[fi]
                return new_uv[(comp[v[0]], t[k])]

            textures = {}
            for col in EYE_COLORS:
                src = folder / 'textures' / (col + '_eye.png')
                size, q = 320, 86
                if col == 'brown' and args.eye_hires and os.path.exists(args.eye_hires):
                    src, size = Path(args.eye_hires), 512
                dst = tex_dir / ('eye_%s.webp' % col)
                # brown: shift the iris from red-brown to a natural dark brown
                n, pupil = eye_texture(src, dst, size, q, *((17.0, 0.72) if col == 'brown' else ()))
                tex_bytes[dst.name] = n
                textures[col] = 'tex/' + dst.name
            e, qerr = emit(name, 'eyes', a['label'], a['src'], p_rest, ref, w, off, ball_faces, ball_uv, den, hw,
                           dict(texture=textures['brown'], textures=textures, tint=[1, 1, 1], authoring=auth))
            report.append((name, e, qerr, auth, n_delete))
            if cornea_faces:
                def cornea_uv(fi, k, fs=cornea_faces):
                    return (0.5, 0.5)
                e, qerr = emit(name.replace('eyes', 'cornea'), 'cornea', 'Cornea', a['src'], p_rest, ref, w, off, cornea_faces,
                               cornea_uv, den, hw, dict(texture=None, tint=[0, 0, 0], authoring=auth))
                report.append((e['name'], e, qerr, auth, n_delete))
            continue

        def uv_fn(fi, k, faces=faces, uv=uv):
            t = uv[faces[fi][1][k]]
            return (float(t[0]), float(t[1]))

        src_tex = sorted((folder / 'textures').glob('*.png'))[0]
        orient = collide = None
        if kind == 'hair':
            dst = tex_dir / ('hair_%s.webp' % name)
            n, tint, cov, orient = hair_texture(src_tex, dst, 512, 82)
            # loose hair (not glued to the scalp) collides with the skin: colliders from the authoring human (M = I)
            auth_v = humans[res[0][2]]
            loose = (hw < 0.999) | (ref >= BODY_VERTS).any(1) | (np.linalg.norm(off, axis=1) > 0.1)
            collide = ((auth_v[ref] * w[:, :, None]).sum(1) + off, loose, auth_v)
        elif kind == 'eyebrows':
            dst = tex_dir / ('brow_%s.webp' % name[-3:])
            n, tint, cov = stroke_texture(src_tex, dst, 512)
        else:
            dst = tex_dir / ('lash_%s.webp' % name[-2:])
            n, tint, cov = stroke_texture(src_tex, dst, 512)
        tex_bytes[dst.name] = n
        e, qerr = emit(name, kind, a['label'], a['src'], p_rest, ref, w, off, faces, uv_fn, den, hw,
                       dict(texture='tex/' + dst.name, tint=[round(float(x), 4) for x in tint], tags=d['tags'], authoring=auth),
                       orient=orient, collide=collide)
        report.append((name, e, qerr, auth, n_delete))

    data = blob.b.getvalue()
    (out_dir / 'proxies.bin').write_bytes(data)
    meta = dict(
        version=1,
        source='MakeHuman system assets (hair, eyebrows, eyelashes, eyes) – CC0 since 2020, makehumancommunity.org',
        unit='decimetre',
        baseVertexCount=N_BASE,
        weightScale=W_SCALE,
        offsetScale=OFF_SCALE,
        clearanceScale=CLR_SCALE,
        collision=dict(margin=COL_MARGIN, slope=COL_SLOPE),
        # rigid frames estimated from the posed base mesh (see src/human/proxies.ts)
        anchors=dict(head=head_anchor, torso=torso_anchor),
        # body faces to hide under a proxy: none of the shipped proxies sets MakeHuman's delete_verts
        deleteVerts=[],
        proxies=proxies,
    )
    (out_dir / 'proxies.json').write_text(json.dumps(meta, separators=(',', ':')))

    print('%-12s %-9s %6s %6s %6s  %-22s %9s %8s %s' % ('proxy', 'kind', 'fitV', 'rendV', 'tris', 'authored on', 'residual', 'quantErr', 'deleteVerts'))
    for name, e, qerr, auth, n_delete in report:
        print('%-12s %-9s %6d %6d %6d  %-22s %9s %8.5f %d' % (
            name, e['kind'], e['fitCount'], e['vertexCount'], e['triCount'], auth['human'],
            '-' if auth.get('residual') is None else '%.5f' % auth['residual'], qerr, n_delete))
    total_tex = sum(tex_bytes.values())
    for k in sorted(tex_bytes):
        print('  tex/%-22s %7.1f KB' % (k, tex_bytes[k] / 1024))
    print('proxies.bin %.1f KB, proxies.json %.1f KB, textures %.1f KB, total %.1f KB (budget 2200 KB)' % (
        len(data) / 1024, os.path.getsize(out_dir / 'proxies.json') / 1024, total_tex / 1024,
        (len(data) + os.path.getsize(out_dir / 'proxies.json') + total_tex) / 1024))


if __name__ == '__main__':
    main()
