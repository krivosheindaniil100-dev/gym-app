#!/usr/bin/env python3
"""
Skin UVs, skin albedo textures, sportswear masks and baked AO for the realistic human ("skin-uv" track).

Sources (all MakeHuman official system assets, CC0 since 2020):
  * base mesh with UVs: makehuman/data/3dobjs/base.obj ("f v/vt", group "body")
  * skins:              makehuman-data public/data/skins/<set>/textures/*.png (512x512 RGB)

Outputs (public/human/):
  uv.bin   – [vt table: uint16 u,v per unique UV (value / 65535, v UP = OpenGL/OBJ convention)]
             [corner table: uint16 x 4 per body quad = index into the vt table, SAME face order and SAME corner
              order as human.json layout.faces.body]
  uv.json  – layout of uv.bin + texture list (mean colours, re-toning formula) + mask/AO channel description
  tex/skin_<set>.webp        – albedo (sRGB), body UV islands dilated into the gutters (mip-safe)
  tex/wear_<male|female>.webp – lossless RGB mask: R fabric coverage, G elastic bands, B seam/wrinkle shading
  tex/skin_ao.webp           – baked ambient occlusion of the rest mesh (optional, greyscale)

Usage:
  python3 tools/mh/build_skin.py [all|uv|tex|wear|ao] [--obj base.obj] [--skins <skins dir>] [--human public/human]
                                 [--full human_full_size.json] [--out public/human]
Deterministic: same inputs → byte-identical outputs.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent.parent
SCRATCH = Path('/tmp/claude-0/-home-user-gym-app/7c91fb80-ada3-505f-ab80-0fc6e00e761f/scratchpad')
DEF_OBJ = SCRATCH / 'mh_raw' / 'makehuman_data_3dobjs_base.obj'
DEF_MHD = SCRATCH / 'mhdata' / 'x' / 'package'
DEF_SKINS = DEF_MHD / 'public' / 'data' / 'skins'
DEF_FULL = DEF_MHD / 'public' / 'data' / 'models' / 'human_full_size.json'


# ───────────────────────── mesh / UV ─────────────────────────

def read_obj_body(obj_path):
    """→ V (n,3 float64, decimetres), VT (m,2), fv (nF,4 vertex idx), ft (nF,4 vt idx) for group 'body'."""
    v, vt, fv, ft = [], [], [], []
    cur = None
    with open(obj_path, encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('v '):
                v.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                vt.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                cur = line[2:].strip()
            elif line.startswith('f ') and cur == 'body':
                parts = [p.split('/') for p in line.split()[1:]]
                a = [int(p[0]) - 1 for p in parts]
                b = [int(p[1]) - 1 for p in parts]
                if len(a) == 3:  # same convention as tools/build_human.py (never happens for hm08)
                    a.append(a[2])
                    b.append(b[2])
                fv.append(a)
                ft.append(b)
    return np.asarray(v, np.float64), np.asarray(vt, np.float64), np.asarray(fv, np.int64), np.asarray(ft, np.int64)


def load_human_faces(human_dir):
    meta = json.loads((Path(human_dir) / 'human.json').read_text())
    off, n = meta['layout']['faces']['body']
    buf = (Path(human_dir) / 'human.bin').read_bytes()
    faces = np.frombuffer(buf, '<u2', n * 4, off).reshape(n, 4).astype(np.int64)
    poff, nv = meta['layout']['positions']
    pos = np.frombuffer(buf, '<f4', nv * 3, poff).reshape(nv, 3).astype(np.float64)
    return faces, pos


def crosscheck_full_json(full_path, fv, uvq):
    """Compare the per-corner UVs with makehuman-data's human_full_size.json (three.js legacy JSON)."""
    d = json.loads(Path(full_path).read_text())
    uvs = np.asarray(d['uvs'][0], np.float64).reshape(-1, 2)
    f = d['faces']
    i = 0
    by_key = {}
    while i < len(f):
        t = f[i]
        i += 1
        n = 4 if t & 1 else 3
        vs = f[i:i + n]
        i += n
        if t & 2:
            i += 1
        if t & 4:
            i += 1
        us = None
        if t & 8:
            us = f[i:i + n]
            i += n
        if t & 16:
            i += 1
        if t & 32:
            i += n
        if t & 64:
            i += 1
        if t & 128:
            i += n
        if us is not None and n == 4:
            by_key[tuple(vs)] = us
    worst = 0.0
    found = 0
    for k in range(fv.shape[0]):
        us = by_key.get(tuple(int(x) for x in fv[k]))
        if us is None:
            continue
        found += 1
        worst = max(worst, float(np.abs(uvs[us] - uvq[k]).max()))
    return found, worst


def build_uv(args):
    V, VT, fv, ft = read_obj_body(args.obj)
    faces, pos = load_human_faces(args.human)
    assert faces.shape == fv.shape, (faces.shape, fv.shape)
    assert np.array_equal(faces, fv), 'body face order/corners differ between base.obj and human.bin'
    assert np.abs(pos - V).max() < 1e-5, 'rest positions differ between base.obj and human.bin'
    # unique UVs by quantised value (so that only real seams split vertices)
    used = np.unique(ft)
    q = np.clip(np.rint(VT * 65535.0), 0, 65535).astype(np.int64)
    key = q[:, 0] * 65536 + q[:, 1]
    uniq, inv = np.unique(key[used], return_inverse=True)
    remap = np.full(VT.shape[0], -1, np.int64)
    remap[used] = inv
    table = np.stack([uniq // 65536, uniq % 65536], 1).astype('<u2')
    corners = remap[ft].astype('<u2')
    assert table.shape[0] < 65536
    uvq = table[corners].astype(np.float64) / 65535.0
    assert np.abs(uvq - VT[ft]).max() < 1.0 / 65535
    check = {'faces': int(fv.shape[0]), 'objVt': int(used.size), 'uniqueVt': int(table.shape[0])}
    if args.full and Path(args.full).exists():
        found, worst = crosscheck_full_json(args.full, fv, uvq)
        check['fullJsonFacesMatched'] = found
        check['fullJsonMaxUvDiff'] = round(worst, 7)
        assert found == fv.shape[0] and worst < 1e-4, (found, worst)
    blob = table.tobytes() + corners.tobytes()
    layout = {'vt': [0, int(table.shape[0])], 'corners': [int(table.nbytes), int(corners.shape[0])]}
    print('uv:', check, 'bytes', len(blob))
    return blob, layout, check, dict(V=V, fv=fv, uv=uvq)


# ───────────────────────── subdivision + UV-space rasteriser ─────────────────────────

def catmull_clark(V, fv, uvq):
    """One Catmull–Clark step of the body (same rules as src/human/engine.ts) → per-triangle corner arrays
    P (nT,3,3) positions, N (nT,3,3) smooth normals, T (nT,3,2) uvs (linear per base quad), base face id (nT,)."""
    nF = fv.shape[0]
    used = np.unique(fv)
    loc = np.full(V.shape[0], -1, np.int64)
    loc[used] = np.arange(used.size)
    q = loc[fv]
    P0 = V[used]
    nV = used.size
    a = q
    b = np.roll(q, -1, axis=1)
    lo = np.minimum(a, b).ravel()
    hi = np.maximum(a, b).ravel()
    ekey, einv, ecount = np.unique(lo * nV + hi, return_inverse=True, return_counts=True)
    nE = ekey.size
    e0 = ekey // nV
    e1 = ekey % nV
    fe = einv.reshape(nF, 4)  # edge of side k (corner k → k+1)
    FP = P0[q].mean(1)
    # edge points
    fsum = np.zeros((nE, 3))
    np.add.at(fsum, fe.ravel(), np.repeat(FP, 4, axis=0))
    interior = ecount == 2
    EP = np.where(interior[:, None], (P0[e0] + P0[e1] + fsum) / 4.0, (P0[e0] + P0[e1]) / 2.0)
    # vertex points
    nf = np.zeros(nV)
    np.add.at(nf, q.ravel(), 1.0)
    Q = np.zeros((nV, 3))
    np.add.at(Q, q.ravel(), np.repeat(FP, 4, axis=0))
    Q /= nf[:, None]
    ne = np.zeros(nV)
    Rm = np.zeros((nV, 3))
    mid = (P0[e0] + P0[e1]) / 2.0
    for e in (e0, e1):
        np.add.at(ne, e, 1.0)
        np.add.at(Rm, e, mid)
    Rm /= ne[:, None]
    VP = (Q + 2.0 * Rm + (ne[:, None] - 3.0) * P0) / ne[:, None]
    bnd = np.zeros(nV, bool)
    bsum = np.zeros((nV, 3))
    bcnt = np.zeros(nV)
    be = ~interior
    for x, y in ((e0, e1), (e1, e0)):
        bnd[x[be]] = True
        np.add.at(bsum, x[be], P0[y[be]])
        np.add.at(bcnt, x[be], 1.0)
    two = bnd & (bcnt == 2)
    VP[bnd] = P0[bnd]
    VP[two] = (6.0 * P0[two] + bsum[two]) / 8.0
    S = np.concatenate([VP, EP, FP], 0)
    # sub-quads [v_k, e_k, fc, e_{k-1}] exactly like engine.ts
    fc = nV + nE + np.arange(nF)
    quads = np.stack([np.stack([q[:, k], nV + fe[:, k], fc, nV + fe[:, (k + 3) & 3]], 1) for k in range(4)], 1).reshape(-1, 4)
    cen = uvq.mean(1)
    quv = np.stack([np.stack([uvq[:, k], (uvq[:, k] + uvq[:, (k + 1) & 3]) / 2, cen, (uvq[:, (k + 3) & 3] + uvq[:, k]) / 2], 1) for k in range(4)], 1).reshape(-1, 4, 2)
    tris = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]], 0)
    T = np.concatenate([quv[:, [0, 1, 2]], quv[:, [0, 2, 3]]], 0)
    face = np.concatenate([np.repeat(np.arange(nF), 4)] * 2)
    # smooth (area-weighted) vertex normals of the subdivided mesh
    Pt = S[tris]
    fn = np.cross(Pt[:, 1] - Pt[:, 0], Pt[:, 2] - Pt[:, 0])
    Nv = np.zeros_like(S)
    for k in range(3):
        np.add.at(Nv, tris[:, k], fn)
    Nv /= np.maximum(np.linalg.norm(Nv, axis=1, keepdims=True), 1e-12)
    return dict(P=Pt, N=Nv[tris], T=T, face=face, S=S, tris=tris)


def raster_uv(T, size):
    """Rasterise UV triangles T (nT,3,2; v up) at texel centres of a size×size image (row 0 = top = v 1).
    → tri (H,W int32, −1 = empty), bary (H,W,3 float32)."""
    X = T[:, :, 0] * size - 0.5          # texel-centre coordinates
    Y = (1.0 - T[:, :, 1]) * size - 0.5
    x0 = np.floor(X.min(1)).astype(np.int64)
    y0 = np.floor(Y.min(1)).astype(np.int64)
    wx = np.ceil(X.max(1)).astype(np.int64) - x0 + 1
    wy = np.ceil(Y.max(1)).astype(np.int64) - y0 + 1
    d = (X[:, 1] - X[:, 0]) * (Y[:, 2] - Y[:, 0]) - (X[:, 2] - X[:, 0]) * (Y[:, 1] - Y[:, 0])
    ok = np.abs(d) > 1e-12
    tri = np.full((size, size), -1, np.int32)
    bary = np.zeros((size, size, 3), np.float32)
    eps = 1e-4
    for dy in range(int(wy.max())):
        for dx in range(int(wx.max())):
            s = np.nonzero(ok & (wx > dx) & (wy > dy))[0]
            if s.size == 0:
                continue
            px = x0[s] + dx
            py = y0[s] + dy
            inb = (px >= 0) & (px < size) & (py >= 0) & (py < size)
            s, px, py = s[inb], px[inb], py[inb]
            w1 = ((px - X[s, 0]) * (Y[s, 2] - Y[s, 0]) - (X[s, 2] - X[s, 0]) * (py - Y[s, 0])) / d[s]
            w2 = ((X[s, 1] - X[s, 0]) * (py - Y[s, 0]) - (px - X[s, 0]) * (Y[s, 1] - Y[s, 0])) / d[s]
            w0 = 1.0 - w1 - w2
            ins = (w0 >= -eps) & (w1 >= -eps) & (w2 >= -eps)
            s, px, py = s[ins], px[ins], py[ins]
            tri[py, px] = s
            bary[py, px] = np.stack([w0[ins], w1[ins], w2[ins]], 1)
    return tri, bary


def dilate(img, valid, iters):
    """Grow `img` (H,W,C float) from `valid` texels into invalid neighbours (mean of valid 8-neighbours), `iters` px."""
    img = img.copy()
    valid = valid.copy()
    H, W = valid.shape
    for _ in range(iters):
        if valid.all():
            break
        acc = np.zeros_like(img)
        cnt = np.zeros((H, W), np.float64)
        pi = np.pad(img * valid[..., None], ((1, 1), (1, 1), (0, 0)))
        pv = np.pad(valid.astype(np.float64), 1)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                if dy == 1 and dx == 1:
                    continue
                acc += pi[dy:dy + H, dx:dx + W]
                cnt += pv[dy:dy + H, dx:dx + W]
        new = (~valid) & (cnt > 0)
        img[new] = acc[new] / cnt[new][:, None]
        valid = valid | new
    return img, valid


class Atlas:
    """Per-texel rest-pose attributes of the subdivided body in UV space."""

    def __init__(self, mesh, size):
        sub = catmull_clark(mesh['V'], mesh['fv'], mesh['uv'])
        self.size = size
        self.sub = sub
        tri, bary = raster_uv(sub['T'], size)
        self.tri = tri
        self.valid = tri >= 0
        t = np.maximum(tri, 0)
        b = bary.astype(np.float64)
        self.pos = np.einsum('hwk,hwkc->hwc', b, sub['P'][t])           # decimetres, rest pose
        n = np.einsum('hwk,hwkc->hwc', b, sub['N'][t])
        self.nrm = n / np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-12)
        # decimetres per texel (isotropic estimate) for analytic anti-aliasing
        P, T = sub['P'], sub['T']
        a3 = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
        a2 = 0.5 * np.abs((T[:, 1, 0] - T[:, 0, 0]) * (T[:, 2, 1] - T[:, 0, 1]) - (T[:, 2, 0] - T[:, 0, 0]) * (T[:, 1, 1] - T[:, 0, 1]))
        self.tri_area3 = a3
        self.tri_area2 = a2
        self.texel = (np.sqrt(a3 / np.maximum(a2, 1e-12)) / size)[t]     # dm per texel
        self.face = sub['face'][t]


# ───────────────────────── skin albedo textures ─────────────────────────

SKINS = {  # key → official MakeHuman system skin (young sets; the cleanest variant of each, see the report)
    'caucasian_male': 'young_caucasian_male/textures/young_lightskinned_male_diffuse2.png',
    'caucasian_female': 'young_caucasian_female/textures/young_lightskinned_female_diffuse2.png',
    'asian_male': 'young_asian_male/textures/young_lightskinned_male_diffuse3.png',
    'asian_female': 'young_asian_female/textures/young_lightskinned_female_diffuse3.png',
    'african_male': 'young_african_male/textures/young_darkskinned_male_diffuse.png',
    'african_female': 'young_african_female/textures/young_darkskinned_female_diffuse.png',
}


def srgb_to_linear(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 0) ** (1 / 2.4) - 0.055)


def grow(mask, px):
    """Binary dilation by px (8-neighbourhood)."""
    m = mask.copy()
    for _ in range(px):
        p = np.pad(m, 1)
        m = p[:-2, :-2] | p[:-2, 1:-1] | p[:-2, 2:] | p[1:-1, :-2] | p[1:-1, 1:-1] | p[1:-1, 2:] | p[2:, :-2] | p[2:, 1:-1] | p[2:, 2:]
    return m


def mean_skin(rgb, at):
    """Robust mean albedo of plain skin: texels of the body islands weighted by their 3D area, with every channel
    inside its 10–90 % range (drops lips, nipples, nails, scalp stubble, mouth). → (linear mean, sRGB of that mean)."""
    lin = srgb_to_linear(rgb[at.valid])
    w = at.texel[at.valid] ** 2
    lo = np.quantile(lin, 0.10, axis=0)
    hi = np.quantile(lin, 0.90, axis=0)
    keep = np.all((lin >= lo) & (lin <= hi), axis=1)
    m = (lin[keep] * w[keep, None]).sum(0) / w[keep].sum()
    return m, linear_to_srgb(m)


def fix_spine(rgb, at):
    """The MakeHuman skins are painted reddish along the back mid-line (the border of the pelt unwrap, a UV seam).
    Equalise the mean colour of the strip |x| < 0.3 dm (lower back … neck) to the skin 3–5 cm beside it, per height
    bin, with a smooth falloff – the painted detail is kept, only the tint is removed."""
    x, y, z = at.pos[..., 0], at.pos[..., 1], at.pos[..., 2]
    ax = np.abs(x)
    back = at.valid & (z < np.interp(y, ZC_Y, ZC_Z)) & (y > 1.1) & (y < 5.9)   # above the gluteal cleft only
    edges = np.arange(1.1, 5.91, 0.24)
    cy, ratio = [], []
    for i in range(len(edges) - 1):
        m = back & (y >= edges[i]) & (y < edges[i + 1])
        a = m & (ax < 0.10)
        b = m & (ax > 0.30) & (ax < 0.55)
        if a.sum() > 4 and b.sum() > 4:
            cy.append(0.5 * (edges[i] + edges[i + 1]))
            ratio.append(np.clip(rgb[b].mean(0) / rgb[a].mean(0), 0.85, 1.2))
    if len(cy) < 2:
        return rgb
    ratio = np.asarray(ratio)
    sm = lambda e0, e1, v: np.clip((v - e0) / (e1 - e0), 0, 1) ** 2 * (3 - 2 * np.clip((v - e0) / (e1 - e0), 0, 1))
    w = (1 - sm(0.10, 0.32, ax)) * back * sm(1.1, 1.6, y) * (1 - sm(5.5, 5.9, y))
    out = rgb.copy()
    for c in range(3):
        out[..., c] *= 1.0 + (np.interp(y, cy, ratio[:, c]) - 1.0) * w
    return np.clip(out, 0, 1)


def process_skin(src_path, at512, size=1024, detail=0.0, seed=7):
    """512² MakeHuman albedo → (image, meanLinear, meanSrgb).
    Everything further than 6 px (at 512) from a body UV island is replaced by the mean skin colour (removes the
    logo / helper-geometry paint, compresses better, keeps mip levels clean). size 1024: Lanczos upscale + mild
    unsharp mask (bicubic-quality magnification baked in, crisper lips / nostrils / eyelids than GPU bilinear)."""
    im = Image.open(src_path).convert('RGB')
    assert im.size == (512, 512), im.size
    rgb = np.asarray(im, np.float64) / 255.0
    mlin, msrgb = mean_skin(rgb, at512)
    rgb = fix_spine(rgb, at512)
    rgb, keep = dilate(rgb, at512.valid, 6)                 # island padding from the island's own texels
    rgb = np.where(keep[..., None], rgb, msrgb[None, None, :])
    out = Image.fromarray(np.clip(np.rint(rgb * 255), 0, 255).astype(np.uint8), 'RGB')
    if size != 512:
        out = out.resize((size, size), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.6, percent=60, threshold=1))
        if detail > 0:  # optional synthetic grain (band-passed noise, luminance only) – off by default, see report
            rng = np.random.default_rng(seed)
            n = Image.fromarray((rng.random((size, size)) * 255).astype(np.uint8), 'L')
            bp = np.asarray(n.filter(ImageFilter.GaussianBlur(0.8)), np.float64) - np.asarray(n.filter(ImageFilter.GaussianBlur(2.5)), np.float64)
            bp /= bp.std()
            k = np.asarray(Image.fromarray(keep.astype(np.uint8) * 255, 'L').resize((size, size), Image.BILINEAR), np.float64) / 255.0
            a = np.asarray(out, np.float64) * (1.0 + detail * bp * k)[..., None]
            out = Image.fromarray(np.clip(np.rint(a), 0, 255).astype(np.uint8), 'RGB')
    return out, mlin, msrgb


# ───────────────────────── sportswear masks ─────────────────────────
# All lengths in decimetres of the REST base mesh (height 16.66 dm; y up, +z front, x = 0 sagittal plane).
# Landmarks of the rest mesh: crotch y ≈ −0.45, navel y ≈ 1.9, under-bust crease y ≈ 3.2, nipples y ≈ 3.85,
# armpit y ≈ 4.3 (|x| ≈ 1.6), shoulder top y ≈ 5.8, torso half width 1.2–1.75, arms |x| > 1.9 below the armpit.

ZC_Y = [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 4.5, 5.0, 6.0]
ZC_Z = [0.25, 0.23, 0.13, 0.17, 0.27, 0.43, 0.53, 0.70, 0.57, 0.40, 0.25, 0.25]   # mid z of the torso per height

WEAR = {
    'male': dict(waist=1.50, dip=0.07, band=0.38, inseam=0.95, hem=0.12, top=False),
    'female': dict(waist=1.58, dip=0.06, band=0.42, inseam=0.38, hem=0.10, top=True),
}


def thigh_axes(S):
    """Unit axis (pointing down the thigh) of the +x leg from cross-section centroids of the subdivided rest mesh."""
    def cen(y):
        m = (np.abs(S[:, 1] - y) < 0.12) & (S[:, 0] > 0.05) & (S[:, 0] < 2.6)
        return S[m].mean(0)
    hi, lo = cen(-1.5), cen(-3.6)
    a = lo - hi
    return a / np.linalg.norm(a)


def build_wear(at, sex):
    """→ float image (H,W,3) in 0..1:
    R fabric coverage as a narrow distance ramp (0.5 = garment edge, ±RAMP/2 texels wide) – use as is (soft edge) or
      sharpen in the shader with smoothstep(0.5 − w, 0.5 + w, R), w = clamp(fwidth(R), 0.02, 0.5) (crisp at any zoom);
    G elastic bands (waistband / under-bust band 1.0, hems and bindings 0.6), valid a few texels beyond the edge;
    B shading, 0.5 neutral: albedo *= 0.5 + B (stitch lines, seams, folds darker; ribs / ridges lighter; soft contact
      shadow on the skin just outside the fabric)."""
    c = WEAR[sex]
    x, y, z = at.pos[..., 0], at.pos[..., 1], at.pos[..., 2]
    ax = np.abs(x)
    tex = np.maximum(at.texel, 1e-4)
    RAMP = 3.0

    def aa(d):  # signed distance (dm, positive inside) → ramp of RAMP texels
        return np.clip(0.5 + d / (RAMP * tex), 0.0, 1.0)

    def line(d, hw):  # thin line of half-width hw (dm) around d = 0, 1-texel anti-aliasing
        return np.clip(0.5 + (hw - np.abs(d)) / tex, 0.0, 1.0)

    zc = np.interp(y, ZC_Y, ZC_Z)
    rr = np.sqrt(x * x + (z - zc) ** 2) + 1e-9
    sfront = (z - zc) / rr                                   # sine of the angle around the body axis: +1 front, −1 back
    front = np.clip(0.5 + (z - zc) / 0.3, 0.0, 1.0)

    # ── bottoms: waistband ring (slightly lower in front) down to a hem ring perpendicular to each thigh axis
    a = thigh_axes(at.sub['S'])
    ref = np.array([0.15, -0.45, 0.30])                     # inner thigh at crotch height (+x leg)
    t = (ax - ref[0]) * a[0] + (y - ref[1]) * a[1] + (z - ref[2]) * a[2]   # distance down the thigh (mirror symmetric)
    d_hem = c['inseam'] - t
    d_waist = c['waist'] - c['dip'] * sfront - y
    d_x = 2.6 - ax
    d_bot = np.minimum(np.minimum(d_waist, d_hem), d_x)
    near_bot = aa(d_bot + 4.0 * tex)                         # garment grown by 4 texels (for G)
    band = aa(c['band'] - d_waist) * near_bot
    hemb = aa(c['hem'] - d_hem) * near_bot
    g = np.maximum(band, 0.6 * hemb)
    shade = np.zeros_like(x)
    inside = np.clip(0.5 + d_bot / tex, 0.0, 1.0)
    # stitch lines: under the waistband, above the hem
    shade -= 0.16 * line(d_waist - c['band'], 0.012) * inside
    shade -= 0.12 * line(d_hem - c['hem'], 0.010) * inside
    # fine ribs on the elastic
    shade += 0.035 * np.sin(d_waist / c['band'] * 2 * np.pi * 3.0) * band * inside
    below_band = np.clip((d_waist - c['band']) / 0.05, 0, 1) * inside
    if sex == 'male':
        # pouch: two curved seams from the waistband (|x| = 0.5) converging at the crotch, front only
        yc = -0.38
        h = c['waist'] - c['band'] - yc
        u = np.clip((y - yc) / h, 0.0, 1.0)
        xs = 0.50 * np.sqrt(u)
        dxs = 0.25 / np.maximum(np.sqrt(u), 0.15) / h
        d_seam = (ax - xs) / np.sqrt(1.0 + dxs * dxs)
        pouch = front * below_band * (y > yc - 0.05)
        shade -= 0.14 * line(d_seam, 0.011) * pouch
        shade += 0.03 * np.exp(-(np.maximum(d_seam, 0) / 0.05) ** 2) * (d_seam > 0) * pouch          # ridge next to the seam
        shade += 0.03 * np.clip(-d_seam / 0.4, 0, 1) * pouch                                         # pouch catches light
    else:
        shade -= 0.10 * line(x, 0.010) * front * below_band * (y > -0.40)                            # centre-front seam
    shade -= 0.10 * line(x, 0.010) * (1 - front) * below_band * (y > -0.30)                          # centre-back seam
    # tension folds fanning out of the groin over the front of the hip (very subtle)
    gx, gy = ax - 0.25, y + 0.35
    r = np.sqrt(gx * gx + gy * gy)
    fold = np.sin(np.arctan2(gy, gx) * 9.0 + 0.6) * np.exp(-((r - 0.75) / 0.45) ** 2) * (gx > 0) * (gy > -0.2)
    shade += 0.030 * fold * front * below_band * (1 - hemb)
    d_all = d_bot

    if c['top']:
        # ── sports bra / crop top: under-bust elastic, scoop neck, wide straps over the shoulder, scoop back
        yb0, bw, bind_w = 2.92, 0.32, 0.10
        y0 = 4.48 * front + 4.80 * (1 - front)              # lowest point of the neckline: front / back
        xi, ytop, pw = 1.00, 5.95, 2.4
        yn = y0 + (ytop - y0) * (ax / xi) ** pw
        dyn = (ytop - y0) * pw * (ax / xi) ** (pw - 1) / xi
        d_neck = (yn - y) / np.sqrt(1.0 + dyn * dyn)
        ya, xmin = 4.75, 1.20
        cq = np.where(y < ya, 0.457, 0.12)
        xa = xmin + cq * (y - ya) ** 2
        dxa = 2 * cq * (y - ya)
        d_arm = (xa - ax) / np.sqrt(1.0 + dxa * dxa)
        d_low = y - yb0
        d_top = np.minimum(np.minimum(d_neck, d_arm), np.minimum(d_low, 2.5 - ax))
        near_top = aa(d_top + 4.0 * tex)
        in_top = np.clip(0.5 + d_top / tex, 0.0, 1.0)
        tband = aa(bw - d_low) * near_top
        d_edge = np.minimum(d_neck, d_arm)
        bind = aa(bind_w - d_edge) * near_top * aa(d_low - bw)
        g = np.maximum(g, np.maximum(tband, 0.6 * bind))
        shade -= 0.16 * line(d_low - bw, 0.012) * in_top
        shade -= 0.10 * line(d_edge - bind_w, 0.009) * in_top * np.clip((d_low - bw) / 0.05, 0, 1)
        shade += 0.035 * np.sin(d_low / bw * 2 * np.pi * 3.0) * tband * in_top
        d_all = np.maximum(d_bot, d_top)
    cover = aa(d_all)
    hard = np.clip(0.5 + d_all / tex, 0.0, 1.0)
    # soft contact shadow on the skin next to the fabric edge + faint rim just inside the edge (thickness cue)
    shade -= 0.13 * np.exp(-(np.minimum(d_all, 0) / 0.07) ** 2) * (1 - hard) * (d_all > -0.4)
    shade += 0.04 * np.exp(-(np.maximum(d_all, 0) / 0.05) ** 2) * hard
    img = np.stack([cover, g, np.clip(0.5 + shade, 0, 1)], -1)
    img[~at.valid] = (0.0, 0.0, 0.5)
    return img


def save_mask(img, valid, path, pad=8):
    out, _ = dilate(img, valid, pad)
    Image.fromarray(np.clip(np.rint(out * 255.0), 0, 255).astype(np.uint8), 'RGB').save(path, 'WEBP', lossless=True, quality=100, method=6)


# ───────────────────────── baked ambient occlusion ─────────────────────────

def bake_ao(mesh, at, passes=2):
    """Disc-based ambient occlusion (Bunnell, GPU Gems 2 ch. 14) of the REST body: every base vertex is a disc
    (area = ¼ of its quads, vertex normal) that shadows every other vertex; the 2nd pass weights each emitter by its
    own accessibility to undo double shadowing. O(n²) in numpy ≈ 10 s. → float image (H,W) 0..1 (1 = unoccluded)."""
    V, fv = mesh['V'], mesh['fv']
    used = np.unique(fv)
    P = V[used].astype(np.float32)
    loc = np.full(V.shape[0], -1, np.int64)
    loc[used] = np.arange(used.size)
    q = loc[fv]
    Pq = P[q].astype(np.float64)
    fn = np.cross(Pq[:, 2] - Pq[:, 0], Pq[:, 3] - Pq[:, 1])          # quad normal × 2·area
    area = np.zeros(used.size)
    N = np.zeros((used.size, 3))
    for k in range(4):
        np.add.at(area, q[:, k], np.linalg.norm(fn, axis=1) * 0.125)
        np.add.at(N, q[:, k], fn)
    N = (N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)).astype(np.float32)
    A = (area / np.pi).astype(np.float32)
    acc = np.ones(used.size, np.float32)
    for _ in range(passes):
        occ = np.zeros(used.size, np.float32)
        for i0 in range(0, used.size, 400):
            r = slice(i0, min(i0 + 400, used.size))
            v = P[None, :, :] - P[r, None, :]                         # receiver → emitter
            d2 = np.einsum('rec,rec->re', v, v) + 1e-6
            inv = 1.0 / np.sqrt(d2)
            cos_e = np.clip(-np.einsum('rec,ec->re', v, N) * inv, 0.0, 1.0)
            cos_r = np.clip(4.0 * np.einsum('rec,rc->re', v, N[r]) * inv, 0.0, 1.0)
            occ[r] = ((1.0 - 1.0 / np.sqrt(A[None, :] / d2 + 1.0)) * cos_e * cos_r * acc[None, :]).sum(1)
        acc = np.clip(1.0 - occ, 0.0, 1.0)
    full = np.zeros((V.shape[0], 3))
    full[used, 0] = acc
    sub = catmull_clark(full, fv, mesh['uv'])                         # smooth the per-vertex AO like the surface
    t = np.maximum(at.tri, 0)
    T = at.sub['T'][t]                                                # barycentrics of the texel centres
    size = at.size
    yy, xx = np.mgrid[0:size, 0:size]
    px = (xx + 0.5) / size
    py = 1.0 - (yy + 0.5) / size
    d = (T[..., 1, 0] - T[..., 0, 0]) * (T[..., 2, 1] - T[..., 0, 1]) - (T[..., 2, 0] - T[..., 0, 0]) * (T[..., 1, 1] - T[..., 0, 1])
    d = np.where(np.abs(d) < 1e-14, 1.0, d)
    w1 = ((px - T[..., 0, 0]) * (T[..., 2, 1] - T[..., 0, 1]) - (T[..., 2, 0] - T[..., 0, 0]) * (py - T[..., 0, 1])) / d
    w2 = ((T[..., 1, 0] - T[..., 0, 0]) * (py - T[..., 0, 1]) - (px - T[..., 0, 0]) * (T[..., 1, 1] - T[..., 0, 1])) / d
    a = sub['P'][t][..., 0]
    img = np.clip((1 - w1 - w2) * a[..., 0] + w1 * a[..., 1] + w2 * a[..., 2], 0.0, 1.0)
    img[~at.valid] = 1.0
    return img


# ───────────────────────── main ─────────────────────────

NIPPLE = np.array([0.849, 3.847, 1.556])   # rest position of the +x nipple (centre of the areola in the skin textures)


def wear_smooth_verts(mesh, radius=0.21):
    """Base vertices of both nipples: relaxing them (uvmesh.relaxVerts) hides the modelled nipples under the top."""
    V = mesh['V']
    n = int(mesh['fv'].max()) + 1
    out = []
    for sx in (1.0, -1.0):
        d = np.linalg.norm(V[:n] - NIPPLE * [sx, 1, 1], axis=1)
        out += np.nonzero(d < radius)[0].tolist()
    return sorted(int(i) for i in out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('what', nargs='?', default='all', choices=['all', 'uv', 'tex', 'wear', 'ao'])
    ap.add_argument('--obj', default=str(DEF_OBJ))
    ap.add_argument('--skins', default=str(DEF_SKINS))
    ap.add_argument('--full', default=str(DEF_FULL))
    ap.add_argument('--human', default=str(ROOT / 'public' / 'human'))
    ap.add_argument('--out', default=str(ROOT / 'public' / 'human'))
    ap.add_argument('--tex-size', type=int, default=1024, choices=[512, 1024])
    ap.add_argument('--quality', type=int, default=90)
    args = ap.parse_args()
    out = Path(args.out)
    (out / 'tex').mkdir(parents=True, exist_ok=True)
    meta_path = out / 'uv.json'
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    what = args.what

    blob, layout, check, mesh = build_uv(args)
    meta.update({
        'source': 'MakeHuman 1.x base mesh UVs + system skins (CC0 since 2020), makehumancommunity.org',
        'convention': 'uv = uint16 / 65535, v up (OpenGL/OBJ): use three.js textures with flipY = true',
        'layout': layout,
        'check': check,
    })
    (out / 'uv.bin').write_bytes(blob)

    if what in ('all', 'tex'):
        at512 = Atlas(mesh, 512)
        texs = {}
        for key, rel in SKINS.items():
            im, mlin, msrgb = process_skin(str(Path(args.skins) / rel), at512, args.tex_size)
            name = f'tex/skin_{key}.webp'
            im.save(out / name, 'WEBP', quality=args.quality, method=6)
            texs[key] = {
                'file': name, 'size': args.tex_size, 'source': rel.split('/')[-1],
                'meanLinear': [round(float(v), 4) for v in mlin], 'meanSrgb': [round(float(v), 4) for v in msrgb],
            }
            print(name, (out / name).stat().st_size // 1024, 'KB mean sRGB', texs[key]['meanSrgb'])
        meta['textures'] = texs
        meta['retone'] = {
            'space': 'linear sRGB (after the texture has been decoded from sRGB)',
            'formula': "albedo' = target * pow(albedo / meanLinear, k)   (per channel; k = 1 → plain gain target / meanLinear)",
            'notes': 'target = wanted mean skin colour (linear). Darkening a light texture works well even for 6x (k = 1, or '
                     'k ≈ 0.85 for flatter contrast); LIGHTENING a dark texture by more than ~1.3x looks wrong (its painted '
                     'highlights and black stubble turn grey) → uvmesh.pickSkinTexture() chooses the texture accordingly.',
        }
    if what in ('all', 'wear'):
        at = Atlas(mesh, 1024)
        wear = {}
        for sex in ('male', 'female'):
            name = f'tex/wear_{sex}.webp'
            save_mask(build_wear(at, sex), at.valid, out / name)
            wear[sex] = {
                'file': name, 'size': 1024, 'colorSpace': 'linear (data)',
                'channels': {
                    'r': 'fabric coverage as a ±1.5 texel distance ramp, 0.5 = edge (sharpen: smoothstep(0.5-w, 0.5+w, r), w = clamp(fwidth(r), 0.02, 0.5))',
                    'g': 'elastic bands: waistband / under-bust band 1.0, hems and bindings 0.6',
                    'b': 'shading, 0.5 neutral: albedo *= 0.5 + b (seams, stitch lines, folds, contact shadow on skin)',
                },
                'garments': ['trunks'] if sex == 'male' else ['crop top', 'shorts'],
            }
            print(name, (out / name).stat().st_size // 1024, 'KB')
        wear['female']['smoothVerts'] = wear_smooth_verts(mesh)
        meta['wear'] = wear
    if what in ('all', 'ao'):
        at512 = Atlas(mesh, 512)
        img, _ = dilate(bake_ao(mesh, at512)[..., None], at512.valid, 8)
        name = 'tex/skin_ao.webp'
        Image.fromarray(np.clip(np.rint(img[..., 0] * 255), 0, 255).astype(np.uint8), 'L').convert('RGB').save(out / name, 'WEBP', quality=88, method=6)
        meta['ao'] = {'file': name, 'size': 512, 'colorSpace': 'linear (data)', 'use': 'material.aoMap (R channel, uv set 0), aoMapIntensity ≈ 1; rest-pose (A-pose) occlusion'}
        print(name, (out / name).stat().st_size // 1024, 'KB')
    meta_path.write_text(json.dumps(meta, indent=1, sort_keys=True) + '\n')
    total = sum(f.stat().st_size for f in list((out / 'tex').glob('skin_*.webp')) + list((out / 'tex').glob('wear_*.webp')))
    print('wrote', out / 'uv.bin', len(blob), 'bytes; skin (+ ao) + wear textures', total // 1024, 'KB')


if __name__ == '__main__':
    sys.exit(main())
