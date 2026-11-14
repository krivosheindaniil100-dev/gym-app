#!/usr/bin/env python3
"""Build the skinning skeleton + baked relaxed standing pose for the Body Twin human.

    python3 tools/mh/build_skeleton.py [--rig default.json] [--weights default_weights.mhw] [--human public/human] [--out public/human]

Outputs (deterministic):
    public/human/skeleton.bin   little-endian typed sections (see `layout` in the JSON)
    public/human/skeleton.json  bones, joints, capsules, pose quaternions
    src/__tests__/skeleton.selftest.json   numpy reference vectors for the vitest suite (not shipped)

Conventions (proved numerically against MakeHuman's skeleton.py / bvh.py, see the track report):
  * Units are DECIMETRES, y up, +z front, +x = the model's LEFT side ("*.L" bones have x > 0).
  * A rig joint position is the MEAN of its helper vertices -> joints follow every morph.
  * A pose is one rotation per bone expressed in GLOBAL axes (rest rotations are identity, like a BVH),
    applied about the bone head and composed parent-first:
        M_bone = M_parent . T(head) . R_bone . T(-head)
    Skinning is plain linear blend: p' = sum_k w_k M_k p.
  * The MakeHuman default rig has 163 bones. Only bones that are actually rotated by the relaxed pose are kept
    (47); every other bone is merged into its nearest kept ancestor (spine/neck/head/face -> root,
    upperarm02 -> upperarm01, metacarpals -> wrist, lower leg -> upperleg01, toes -> foot ...).
  * The relaxed pose is PROCEDURAL (see POSE / design()): it is solved on the default mesh, mirrored L->R and
    baked as quaternions [x,y,z,w]; the runtime slerps identity -> pose with t.
  * armAbductionDeg / legAbductionDeg: extra rotation about the WORLD z axis through the posed shoulder / hip
    joint (left: +angle, right: -angle; the feet counter-rotate so the soles stay flat). Both are scaled by t.
  * Pose corrective: linear blending pinches the deltoid / armpit a little when the arm drops from the A-pose.
    A delta-mush solve on the default body is baked as a sparse rest-space offset (int8) that the runtime adds,
    scaled by t and rotated by the vertex' blended matrix.

The module doubles as the numpy REFERENCE implementation of src/human/skeleton.ts (class Skel).
Only numpy is required.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = '/tmp/claude-0/-home-user-gym-app/7c91fb80-ada3-505f-ab80-0fc6e00e761f/scratchpad'

# ───────────────────────────── small maths ─────────────────────────────

def nrm(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def aa(axis, deg):
    """axis-angle (degrees) -> 3x3 rotation"""
    x, y, z = nrm(axis)
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def swing(a, b):
    """shortest rotation taking direction a to direction b"""
    a = nrm(a); b = nrm(b)
    ax = np.cross(a, b)
    s = np.linalg.norm(ax)
    if s < 1e-9:
        return np.eye(3)
    return aa(ax / s, np.degrees(np.arctan2(s, np.dot(a, b))))


def mat_to_quat(R):
    """3x3 -> [x,y,z,w], w >= 0"""
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1) * 2; w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s; y = (R[0, 2] - R[2, 0]) / s; z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        w = (R[2, 1] - R[1, 2]) / s; x = 0.25 * s; y = (R[0, 1] + R[1, 0]) / s; z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        w = (R[0, 2] - R[2, 0]) / s; x = (R[0, 1] + R[1, 0]) / s; y = 0.25 * s; z = (R[1, 2] + R[2, 1]) / s
    else:
        s = np.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        w = (R[1, 0] - R[0, 1]) / s; x = (R[0, 2] + R[2, 0]) / s; y = (R[1, 2] + R[2, 1]) / s; z = 0.25 * s
    q = np.array([x, y, z, w]); q /= np.linalg.norm(q)
    return q if q[3] >= 0 else -q


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def rot_z(deg):
    t = np.radians(deg); c, s = np.cos(t), np.sin(t)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


# ───────────────────────────── inputs ─────────────────────────────

def load_human(human_dir):
    """-> (V float64 (nV,3) decimetres, body quads (nF,4), meta, raw buffer)"""
    human_dir = Path(human_dir)
    meta = json.loads((human_dir / 'human.json').read_text())
    buf = (human_dir / 'human.bin').read_bytes()
    off, n = meta['layout']['positions']
    V = np.frombuffer(buf, '<f4', n * 3, off).reshape(n, 3).astype(np.float64)
    o, c = meta['layout']['faces']['body']
    body = np.frombuffer(buf, '<u2', c * 4, o).reshape(c, 4).astype(np.int64)
    return V, body, meta, buf


def human_target(meta, buf, name):
    """morph target from human.bin -> (idx, delta dm)"""
    for t in meta['targets']:
        if t['name'] == name:
            idx = np.frombuffer(buf, '<u2', t['n'], t['idx']).astype(np.int64)
            vec = np.frombuffer(buf, '<i2', t['n'] * 3, t['vec']).reshape(-1, 3).astype(np.float64) * meta['vectorScale']
            return idx, vec
    raise KeyError(name)


class Rig:
    """MakeHuman default rig: bones in breadth-first order, joints = helper-vertex index lists, dense weights."""

    def __init__(self, rig_path, weights_path, n_verts):
        rig = json.loads(Path(rig_path).read_text(encoding='utf-8'))
        bones = rig['bones']
        order = []
        while len(order) != len(bones):          # breadth-first like MakeHuman (parents always precede children)
            done = set(order)
            for n in bones:
                if n not in done and (not bones[n].get('parent') or bones[n]['parent'] in done):
                    order.append(n)
        self.names = order
        self.index = {n: i for i, n in enumerate(order)}
        self.parent = np.array([self.index[bones[n]['parent']] if bones[n].get('parent') else -1 for n in order])
        self.head_j = [bones[n]['head'] for n in order]
        self.tail_j = [bones[n]['tail'] for n in order]
        self.joints = rig['joints']
        w = json.loads(Path(weights_path).read_text(encoding='utf-8'))['weights']
        W = np.zeros((n_verts, len(order)))
        for b, lst in w.items():
            a = np.asarray(lst, float)
            np.add.at(W[:, self.index[b]], a[:, 0].astype(int), a[:, 1])
        tot = W.sum(1)
        W[tot == 0, self.index['root']] = 1
        self.W = W / W.sum(1, keepdims=True)

    def heads_tails(self, V):
        jp = {j: V[idx].mean(0) for j, idx in self.joints.items()}
        return np.array([jp[j] for j in self.head_j]), np.array([jp[j] for j in self.tail_j])

    def subtree(self, name):
        """bone indices of `name` and all its descendants"""
        root = self.index[name]
        keep = np.zeros(len(self.names), bool); keep[root] = True
        for i in range(len(self.names)):          # BFS order: parents first
            if self.parent[i] >= 0 and keep[self.parent[i]]:
                keep[i] = True
        return np.where(keep)[0]


# ───────────────────────────── the relaxed pose ─────────────────────────────
# All angles in degrees. Tuned visually on the default / obese male / lean female bodies.
POSE = dict(
    clav_drop=3.0, shoulder_drop=7.0,      # rotation about z of clavicle / shoulder01 (scapula follows the arm 1:2)
    arm_abd=13.0,                          # upper arm angle from vertical in the frontal plane
    arm_fwd=-2.0,                          # upper arm forward(+)/back(-) angle in the sagittal plane
    elbow_bend=20.0,                       # remaining elbow flexion
    palm_back=25.0,                        # palm normal: medial, rotated towards the back by this angle
    twist_split=(0.0, 0.5, 0.5),           # share of the forearm twist on lowerarm01 / lowerarm02 / wrist
    wrist_flex=3.0,
    mcp=(10, 16, 20, 14), pip=(14, 15, 15, 21), dip=(8, 11, 12, 12),   # finger curl, fingers 2..5
    spread_in=(-6.0, 4.0, 9.0, 8.0),       # rotation of fingers 2..5 about the palm normal (+ = towards the thumb)
    thumb_dir=(0.94, 0.30, 0.16), thumb_mcp=6.0, thumb_ip=10.0,
    leg_add=6.2,                           # thigh adduction about z (A-pose legs are spread; brings feet to hip width)
    toe_out=4.0,                           # external rotation of the whole leg about y
)


def design(H, T, index, **kw):
    """H, T: rest heads / tails (nB,3) of the DEFAULT mesh. -> {bone: 3x3 local rotation in global axes}."""
    p = dict(POSE); p.update(kw)
    P = {}
    hd = lambda b: H[index[b]]
    # ── left arm ──
    Rc = aa([0, 0, 1], -p['clav_drop']); Rs = aa([0, 0, 1], -p['shoulder_drop'])
    P['clavicle.L'] = Rc; P['shoulder01.L'] = Rs
    Gpar = Rc @ Rs
    sh, el, wr = hd('upperarm01.L'), hd('lowerarm01.L'), hd('wrist.L')
    u0 = nrm(el - sh); f0 = nrm(wr - el)
    a, f = np.radians(p['arm_abd']), np.radians(p['arm_fwd'])
    ut = nrm([np.sin(a) * np.cos(f), -np.cos(a) * np.cos(f), np.sin(f)])
    Pua = Gpar.T @ swing(Gpar @ u0, ut) @ Gpar
    P['upperarm01.L'] = Pua
    Gua = Gpar @ Pua
    # elbow hinge: keep `elbow_bend` of the A-pose flexion
    n0 = nrm(np.cross(u0, f0)); bend0 = np.degrees(np.arccos(np.dot(u0, f0)))
    Rh = aa(n0, -(bend0 - p['elbow_bend']))
    # forearm twist so that the palm faces the thigh (slightly backwards)
    K2, K3, K5 = hd('finger2-1.L'), hd('finger3-1.L'), hd('finger5-1.L')
    npalm = nrm(np.cross(K5 - K2, K3 - wr))
    G = Gua @ Rh
    fw = G @ f0
    b = np.radians(p['palm_back'])
    nt = np.array([-np.cos(b), 0, -np.sin(b)])

    def proj(v):
        v = v - fw * np.dot(v, fw)
        return v / np.linalg.norm(v)
    c0 = proj(G @ npalm); c1 = proj(nt)
    tau = np.degrees(np.arctan2(np.dot(np.cross(c0, c1), fw), np.dot(c0, c1)))
    s1, s2, s3 = p['twist_split']
    P['lowerarm01.L'] = Rh @ aa(f0, tau * s1)
    P['lowerarm02.L'] = aa(f0, tau * s2)
    hdir = nrm(K3 - wr)
    flex_axis = nrm(np.cross(hdir, npalm))
    P['wrist.L'] = aa(f0, tau * s3) @ aa(flex_axis, p['wrist_flex'])
    # ── fingers 2..5: curl about the axis across the palm, slight convergence ──
    for k, fn in enumerate((2, 3, 4, 5)):
        for j, key in enumerate(('mcp', 'pip', 'dip')):
            bn = f'finger{fn}-{j + 1}.L'
            d = nrm(T[index[bn]] - H[index[bn]])
            R = aa(nrm(np.cross(d, npalm)), p[key][k])
            if j == 0:
                R = R @ aa(npalm, p['spread_in'][k])
            P[bn] = R
    # ── thumb: swing the CMC joint towards a direction given in the hand frame, then flex ──
    side = np.cross(npalm, hdir)
    d0 = nrm(T[index['finger1-3.L']] - H[index['finger1-1.L']])
    c = p['thumb_dir']
    P['finger1-1.L'] = swing(d0, nrm(c[0] * hdir + c[1] * side + c[2] * npalm))
    pad = nrm(npalm - side)
    for bn, ang in (('finger1-2.L', p['thumb_mcp']), ('finger1-3.L', p['thumb_ip'])):
        d = nrm(T[index[bn]] - H[index[bn]])
        P[bn] = aa(nrm(np.cross(d, pad)), ang)
    # ── left leg ──
    P['upperleg01.L'] = aa([0, 1, 0], p['toe_out']) @ aa([0, 0, 1], -p['leg_add'])
    P['foot.L'] = aa([0, 0, 1], p['leg_add'])
    # ── mirror to the right side ──
    Mx = np.diag([-1.0, 1, 1])
    for bn in list(P):
        P[bn[:-2] + '.R'] = Mx @ P[bn] @ Mx
    return P


# ───────────────────────────── numpy reference runtime ─────────────────────────────

PROBES = ('armL', 'armR', 'uarmL', 'uarmR', 'torsoL', 'torsoR', 'legL', 'legR')


class Skel:
    """Reference implementation of src/human/skeleton.ts working on the on-disk asset."""

    def __init__(self, meta, buf):
        self.meta = meta
        L = meta['layout']

        def arr(key, dt):
            off, n = L[key]
            return np.frombuffer(buf, dt, n, off)
        self.nV = meta['nVerts']
        self.sidx = arr('skinIndex', 'u1').reshape(-1, 4).astype(np.int64)
        self.sw = arr('skinWeight', 'u1').reshape(-1, 4).astype(np.float64) / 255.0
        self.joff = arr('jointOffset', '<u2').astype(np.int64)
        self.jverts = arr('jointVerts', '<u2').astype(np.int64)
        self.cidx = arr('corrIndex', '<u2').astype(np.int64)
        self.cvec = arr('corrVec', 'i1').reshape(-1, 3).astype(np.float64) * meta['corrScale']
        self.capoff = arr('capOffset', '<u2').astype(np.int64)
        self.capverts = arr('capVerts', '<u2').astype(np.int64)
        self.probe = {k: arr('probe_' + k, '<u2').astype(np.int64) for k in PROBES}
        B = meta['bones']
        self.nB = len(B)
        self.parent = [b['parent'] for b in B]
        self.head = [b['head'] for b in B]
        self.q = np.array([b['q'] for b in B], float)
        self.arm_sign = [b.get('arm', 0) for b in B]
        self.leg_sign = [b.get('leg', 0) for b in B]
        self.jbone = [j['bone'] for j in meta['joints']]
        self.jname = {j['name']: i for i, j in enumerate(meta['joints'])}

    def compute_joints(self, P):
        return np.array([P[self.jverts[self.joff[j]:self.joff[j + 1]]].mean(0) for j in range(len(self.jbone))])

    def pose(self, J, t=1.0, arm=0.0, leg=0.0):
        """-> (nB,3,4) skin matrices"""
        M = np.zeros((self.nB, 3, 4))
        for i in range(self.nB):
            x, y, z, w = self.q[i]
            half = np.arccos(min(1.0, w)); s = np.sin(half)
            if s > 1e-9:
                k = np.sin(t * half) / s
                R = quat_to_mat([x * k, y * k, z * k, np.cos(t * half)])
            else:
                R = np.eye(3)
            h = J[self.head[i]]
            p = self.parent[i]
            Rp, tp = (np.eye(3), np.zeros(3)) if p < 0 else (M[p, :, :3], M[p, :, 3])
            lin = Rp @ R
            pos = Rp @ h + tp
            ang = (self.arm_sign[i] * arm + self.leg_sign[i] * leg) * t
            if ang != 0:
                lin = rot_z(ang) @ lin
            M[i, :, :3] = lin
            M[i, :, 3] = pos - lin @ h
        return M

    def blend(self, M, idx=None):
        si, sw = (self.sidx, self.sw) if idx is None else (self.sidx[idx], self.sw[idx])
        return np.einsum('vk,vkij->vij', sw, M[si])

    def skin(self, M, P, t=1.0, corrective=True):
        A = self.blend(M)
        out = np.einsum('vij,vj->vi', A[:, :, :3], P) + A[:, :, 3]
        if corrective and len(self.cidx):
            out[self.cidx] += t * np.einsum('vij,vj->vi', A[self.cidx, :, :3], self.cvec)
        return out

    def skin_subset(self, M, P, idx):
        A = self.blend(M, idx)
        return np.einsum('vij,vj->vi', A[:, :, :3], P[idx]) + A[:, :, 3]

    def pose_joints(self, M, J):
        Mj = M[self.jbone]
        return np.einsum('jab,jb->ja', Mj[:, :, :3], J) + Mj[:, :, 3]

    def capsules(self, M, J, P):
        """-> (nCap,7): posed ax,ay,az,bx,by,bz,radius (dm); radii measured on the REST mesh P"""
        out = []
        for c, cap in enumerate(self.meta['capsules']):
            S = P[self.capverts[self.capoff[c]:self.capoff[c + 1]]]
            if cap['type'] == 'limb':
                a, b = J[cap['a']], J[cap['b']]
                d = b - a; d /= np.linalg.norm(d)
                rel = S - a
                r = np.linalg.norm(rel - np.outer(rel @ d, d), axis=1).mean() * cap['k']
                Ma, Mb = M[self.jbone[cap['a']]], M[self.jbone[cap['b']]]
                a = Ma[:, :3] @ a + Ma[:, 3]; b = Mb[:, :3] @ b + Mb[:, 3]
            else:
                mn, mx = S.min(0), S.max(0)
                ctr = (mn + mx) / 2; ext = (mx - mn) / 2
                if cap['axis'] == 'x':      # torso slab: horizontal capsule, radius = half depth
                    r = ext[2] * cap['k']
                    hl = max(ext[0] - r, 0.0)
                    ctr[1] = S[:, 1].mean()
                    a = ctr - [hl, 0, 0]; b = ctr + [hl, 0, 0]
                else:                       # head: vertical capsule
                    r = 0.5 * (ext[0] + ext[2]) * cap['k']
                    hl = max(ext[1] - r, 0.0)
                    a = ctr - [0, hl, 0]; b = ctr + [0, hl, 0]
                Mb = M[cap['bone']]
                a = Mb[:, :3] @ a + Mb[:, 3]; b = Mb[:, :3] @ b + Mb[:, 3]
            out.append([*a, *b, r])
        return np.array(out)

    # -- abduction estimate ------------------------------------------------------------------
    GRID = 40

    def _arm_need(self, M, P, J, side, gap, soft):
        s = 1.0 if side == 'L' else -1.0
        sh = J[self.jname['upperarm01.' + side]]; kn = J[self.jname['lowerleg01.' + side]]; hip = J[self.jname['upperleg01.' + side]]
        y0 = kn[1] - 0.5
        n = self.GRID
        cell = (sh[1] - y0) / n
        z0 = hip[2] - 0.5 * n * cell
        grid = np.full((n + 2, n + 2), -1e9)
        Tp = self.skin_subset(M, P, self.probe['torso' + side])
        iy = np.floor((Tp[:, 1] - y0) / cell).astype(int); iz = np.floor((Tp[:, 2] - z0) / cell).astype(int)
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                yy = iy + dy; zz = iz + dz
                ok = (yy >= 0) & (yy < n) & (zz >= 0) & (zz < n)
                np.maximum.at(grid, (yy[ok], zz[ok]), s * Tp[ok, 0])
        worst = 0.0
        for key, g in (('arm', gap), ('uarm', -soft)):       # forearm + hand keep a gap, the upper arm may press in
            Ap = self.skin_subset(M, P, self.probe[key + side])
            iy = np.floor((Ap[:, 1] - y0) / cell).astype(int); iz = np.floor((Ap[:, 2] - z0) / cell).astype(int)
            ok = (iy >= 0) & (iy < n) & (iz >= 0) & (iz < n)
            xt = np.full(len(Ap), -1e9); xt[ok] = grid[iy[ok], iz[ok]]
            pen = xt + g - s * Ap[:, 0]
            lever = np.maximum(sh[1] - Ap[:, 1], 1.0)
            need = np.where((xt > -1e8) & (pen > 0), pen / lever, 0.0)
            worst = max(worst, float(need.max()) if len(need) else 0.0)
        return worst

    def _leg_need(self, M, P, J, side, soft):
        s = 1.0 if side == 'L' else -1.0
        hip = J[self.jname['upperleg01.' + side]]
        Lp = self.skin_subset(M, P, self.probe['leg' + side])
        pen = -0.5 * soft - s * Lp[:, 0]
        lever = np.maximum(hip[1] - Lp[:, 1], 1.0)
        need = np.where(pen > 0, pen / lever, 0.0)
        return float(need.max()) if len(need) else 0.0

    def estimate_abduction(self, P, J, arm_gap=0.1, soft=0.2, max_arm=45.0, max_leg=20.0, iters=6):
        """Minimum extra abduction (degrees, at t = 1) so that forearms / hands clear the torso + thighs by
        arm_gap dm, while soft tissue may overlap by at most `soft` dm in total where the upper arm rests on the
        chest and where the thighs meet (real bodies touch there). First-order estimate refined iteratively."""
        leg = 0.0
        for _ in range(iters):
            M = self.pose(J, 1.0, 0.0, leg)
            need = max(self._leg_need(M, P, J, 'L', soft), self._leg_need(M, P, J, 'R', soft))
            if need < 1e-4:
                break
            leg = min(leg + np.degrees(need) * 1.02, max_leg)
        arm = 0.0
        for _ in range(iters):
            M = self.pose(J, 1.0, arm, leg)
            need = max(self._arm_need(M, P, J, 'L', arm_gap, soft), self._arm_need(M, P, J, 'R', arm_gap, soft))
            if need < 1e-4:
                break
            arm = min(arm + np.degrees(need) * 1.02, max_arm)
        return arm, leg


def load_skeleton(out_dir):
    out_dir = Path(out_dir)
    return Skel(json.loads((out_dir / 'skeleton.json').read_text()), (out_dir / 'skeleton.bin').read_bytes())


# ───────────────────────────── builder ─────────────────────────────

def quantise_weights(W4):
    """rows of non-negative weights -> uint8 rows summing to exactly 255 (largest-remainder rounding)"""
    W4 = W4 / W4.sum(1, keepdims=True) * 255.0
    q = np.floor(W4).astype(np.int64)
    rem = 255 - q.sum(1)
    order = np.argsort(-(W4 - q), axis=1, kind='stable')
    for k in range(W4.shape[1]):
        add = rem > k
        q[np.where(add)[0], order[add, k]] += 1
    assert (q.sum(1) == 255).all()
    return q.astype(np.uint8)


def body_edges(body, n_verts):
    e = np.concatenate([body[:, [0, 1]], body[:, [1, 2]], body[:, [2, 3]], body[:, [3, 0]]])
    e = e[e[:, 0] != e[:, 1]]
    e = np.unique(np.sort(e, axis=1), axis=0)
    deg = np.zeros(n_verts)
    np.add.at(deg, e[:, 0], 1); np.add.at(deg, e[:, 1], 1)
    return e, deg


def laplacian_smooth(P, e, deg, iters, lam=0.5):
    P = P.copy()
    m = ((deg > 0) * lam)[:, None]
    for _ in range(iters):
        A = np.zeros_like(P)
        np.add.at(A, e[:, 0], P[e[:, 1]]); np.add.at(A, e[:, 1], P[e[:, 0]])
        A /= np.maximum(deg, 1)[:, None]
        P = P + m * (A - P)
    return P


def delta_mush(V, Plbs, A3, e, deg, iters=10):
    """classic delta mush: smooth the posed mesh, re-add the rest-pose detail rotated by the blended matrices"""
    d = V - laplacian_smooth(V, e, deg, iters)
    return laplacian_smooth(Plbs, e, deg, iters) + np.einsum('vij,vj->vi', A3, d)


def build(args):
    V, body, hmeta, hbuf = load_human(args.human)
    nV = len(V)
    rig = Rig(args.rig, args.weights, nV)
    H, T = rig.heads_tails(V)
    Pd = design(H, T, rig.index)

    # ── kept bones (root + every posed bone), merged weights ──
    kept = ['root'] + [n for n in rig.names if n in Pd]
    kidx = {n: i for i, n in enumerate(kept)}
    rep = np.zeros(len(rig.names), int)           # rig bone -> kept bone index
    for i, n in enumerate(rig.names):             # BFS order: the parent's rep is known
        rep[i] = kidx[n] if n in kidx else (rep[rig.parent[i]] if rig.parent[i] >= 0 else 0)
    kparent = [-1 if n == 'root' else int(rep[rig.parent[rig.index[n]]]) for n in kept]
    Wk = np.zeros((nV, len(kept)))
    for i in range(len(rig.names)):
        Wk[:, rep[i]] += rig.W[:, i]
    order = np.argsort(-Wk, axis=1, kind='stable')[:, :4]
    W4 = np.take_along_axis(Wk, order, axis=1)
    lost = 1 - W4.sum(1)
    q4 = quantise_weights(W4)
    order = np.where(q4 > 0, order, 0).astype(np.uint8)
    # keep the dominant influence in slot 0 (the runtime has a fast path for weight 255)
    srt = np.argsort(-q4.astype(int), axis=1, kind='stable')
    q4 = np.take_along_axis(q4, srt, axis=1); order = np.take_along_axis(order, srt, axis=1)

    # ── joints ──
    joints = []       # (name, rig joint name, kept bone index that moves it)
    jindex = {}

    def add_joint(name, rig_joint, bone):
        if name not in jindex:
            jindex[name] = len(joints)
            joints.append((name, rig_joint, int(bone)))
        return jindex[name]
    for n in kept:                                # joint named like the bone whose HEAD it is
        add_joint(n, rig.head_j[rig.index[n]], kidx[n])
    extra = ['spine05', 'spine03', 'spine02', 'spine01', 'neck01', 'head']
    for sd in 'LR':
        extra += [f'{b}.{sd}' for b in ('upperarm02', 'upperleg02', 'lowerleg01', 'lowerleg02', 'toe3-1')]
    for n in extra:
        add_joint(n, rig.head_j[rig.index[n]], rep[rig.index[n]])
    add_joint('head_top', rig.tail_j[rig.index['head']], rep[rig.index['head']])
    for sd in 'LR':
        for f in range(1, 6):
            b = f'finger{f}-3.{sd}'
            add_joint(f'fingertip{f}.{sd}', rig.tail_j[rig.index[b]], kidx[b])
    joff = np.zeros(len(joints) + 1, np.uint16)
    jverts = []
    for k, (_, rj, _) in enumerate(joints):
        jverts += list(rig.joints[rj])
        joff[k + 1] = len(jverts)
    jverts = np.asarray(jverts, np.uint16)
    Jrest = np.array([V[rig.joints[rj]].mean(0) for _, rj, _ in joints])

    bones_meta = []
    for i, n in enumerate(kept):
        b = dict(name=n, parent=kparent[i], head=jindex[n],
                 q=[round(float(x), 6) for x in (mat_to_quat(Pd[n]) if n in Pd else [0, 0, 0, 1])])
        if n.startswith('upperarm01.'):
            b['arm'] = 1 if n.endswith('.L') else -1
        if n.startswith('upperleg01.'):
            b['leg'] = 1 if n.endswith('.L') else -1
        if n.startswith('foot.'):
            b['leg'] = -1 if n.endswith('.L') else 1
        bones_meta.append(b)

    # ── capsules ──
    body_verts = np.unique(body)
    is_body = np.zeros(nV, bool); is_body[body_verts] = True
    dom = rig.W.argmax(1)                         # dominant ORIGINAL rig bone per vertex

    def bone_set(*names):
        m = np.zeros(len(rig.names), bool)
        for n in names:
            m[rig.index[n]] = True
        return m

    def sub_set(*names):
        m = np.zeros(len(rig.names), bool)
        for n in names:
            m[rig.subtree(n)] = True
        return m

    def stride(idx, n_max):
        idx = np.sort(idx)
        step = max(1, int(np.ceil(len(idx) / n_max)))
        return idx[::step]

    caps = []
    capoff = [0]; capverts = []

    def limb(name, ja, jb, bones, lo=0.2, hi=0.8, k=1.0):
        a, b = Jrest[jindex[ja]], Jrest[jindex[jb]]
        d = b - a; ln = np.linalg.norm(d); d /= ln
        s = (V - a) @ d / ln
        sel = np.where(is_body & bones[dom] & (s > lo) & (s < hi))[0]
        assert len(sel) >= 8, (name, len(sel))
        sel = stride(sel, 40)
        caps.append(dict(name=name, type='limb', a=jindex[ja], b=jindex[jb], k=k))
        capverts.extend(sel.tolist()); capoff.append(len(capverts))

    def box(name, axis, sel, k=1.0):
        sel = stride(sel, 64)
        caps.append(dict(name=name, type='box', axis=axis, bone=0, k=k))
        capverts.extend(sel.tolist()); capoff.append(len(capverts))

    arm_tree = sub_set('clavicle.L', 'clavicle.R')
    leg_tree = sub_set('upperleg01.L', 'upperleg01.R')
    head_tree = sub_set('head')
    trunk = is_body & ~arm_tree[dom] & ~leg_tree[dom] & ~head_tree[dom]
    yj = lambda n: Jrest[jindex[n]][1]
    box('head', 'y', np.where(is_body & head_tree[dom] & (V[:, 1] > yj('head') - 0.2))[0], k=0.97)
    limb('neck', 'neck01', 'head', sub_set('neck01') & ~head_tree, 0.15, 0.85)
    for nm, yc in (('chest', yj('spine01') - 0.1), ('abdomen', yj('spine03') + 0.25), ('pelvis', yj('root'))):
        box(nm, 'x', np.where((trunk | (is_body & leg_tree[dom])) & (np.abs(V[:, 1] - yc) < 0.45))[0], k=0.95)
    for sd in 'LR':
        limb(f'upperarm.{sd}', f'upperarm01.{sd}', f'lowerarm01.{sd}', bone_set(f'upperarm01.{sd}', f'upperarm02.{sd}'), 0.3, 0.85)
        limb(f'forearm.{sd}', f'lowerarm01.{sd}', f'wrist.{sd}', bone_set(f'lowerarm01.{sd}', f'lowerarm02.{sd}'))
        limb(f'hand.{sd}', f'wrist.{sd}', f'finger3-2.{sd}', sub_set(f'wrist.{sd}'), 0.1, 0.9, k=0.9)
        limb(f'thigh.{sd}', f'upperleg01.{sd}', f'lowerleg01.{sd}', bone_set(f'upperleg01.{sd}', f'upperleg02.{sd}'), 0.25, 0.85)
        limb(f'shank.{sd}', f'lowerleg01.{sd}', f'foot.{sd}', bone_set(f'lowerleg01.{sd}', f'lowerleg02.{sd}'))
        limb(f'foot.{sd}', f'foot.{sd}', f'toe3-1.{sd}', sub_set(f'foot.{sd}'), 0.15, 0.95, k=0.8)

    # ── probes for estimateAbduction ──
    Wsub = lambda name: rig.W[:, rig.subtree(name)].sum(1)
    probes = {}
    for sd, sg in (('L', 1.0), ('R', -1.0)):
        sh = Jrest[jindex[f'upperarm01.{sd}']]; el = Jrest[jindex[f'lowerarm01.{sd}']]
        hip = Jrest[jindex[f'upperleg01.{sd}']]; kn = Jrest[jindex[f'lowerleg01.{sd}']]
        w_arm = Wsub(f'upperarm01.{sd}')
        dist = np.linalg.norm(V - sh, axis=1)
        w_fore = Wsub(f'lowerarm01.{sd}')
        probes['arm' + sd] = stride(np.where(is_body & (w_fore > 0.9))[0], 700)
        probes['uarm' + sd] = np.where(is_body & (w_arm > 0.95) & (w_fore <= 0.9) & (dist > 0.5 * np.linalg.norm(el - sh)))[0]
        w_anyarm = Wsub('upperarm01.L') + Wsub('upperarm01.R')
        probes['torso' + sd] = np.where(is_body & (w_anyarm < 0.05) & (sg * V[:, 0] > 0.3)
                                        & (V[:, 1] > kn[1] - 0.5) & (V[:, 1] < sh[1] - 0.6))[0]
        w_leg = Wsub(f'upperleg01.{sd}')
        probes['leg' + sd] = (np.where(is_body & (w_leg > 0.9) & (V[:, 1] < hip[1] - 1.0)
                                             & (V[:, 1] > Jrest[jindex[f'foot.{sd}']][1]))[0])

    # ── write (corrective is appended after the first pass) ──
    def write(corr_idx, corr_vec, corr_scale):
        sections = [('skinIndex', order.astype(np.uint8).ravel()), ('skinWeight', q4.ravel()),
                    ('corrVec', corr_vec.astype(np.int8).ravel()),
                    ('jointOffset', joff), ('jointVerts', jverts),
                    ('corrIndex', corr_idx.astype(np.uint16)),
                    ('capOffset', np.asarray(capoff, np.uint16)), ('capVerts', np.asarray(capverts, np.uint16))]
        sections += [('probe_' + k, probes[k].astype(np.uint16)) for k in PROBES]
        blob = bytearray(); layout = {}
        for key, a in sections:
            if len(blob) % 2:
                blob += b'\0'
            layout[key] = [len(blob), int(a.size)]
            blob += a.astype(a.dtype.newbyteorder('<')).tobytes()
        meta = dict(
            source='MakeHuman default rig + weights (CC0), relaxed pose designed procedurally (tools/mh/build_skeleton.py)',
            unit='decimetre', nVerts=nV, corrScale=corr_scale, pose={k: (list(v) if isinstance(v, tuple) else v) for k, v in POSE.items()},
            layout=layout, bones=bones_meta,
            joints=[dict(name=n, bone=b) for n, _, b in joints],
            capsules=caps)
        out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
        (out / 'skeleton.bin').write_bytes(bytes(blob))
        (out / 'skeleton.json').write_text(json.dumps(meta, separators=(',', ':')) + '\n')
        return meta, bytes(blob)

    meta, blob = write(np.zeros(0, np.uint16), np.zeros((0, 3), np.int8), 1.0)
    sk = Skel(meta, blob)

    # ── pose corrective from a delta-mush solve on the default body ──
    J = sk.compute_joints(V)
    M = sk.pose(J, 1.0)
    A = sk.blend(M)
    Plbs = sk.skin(M, V, corrective=False)
    e, deg = body_edges(body, nV)
    Pdm = delta_mush(V, Plbs, A[:, :, :3], e, deg, args.mush_iters)
    crest = np.einsum('vij,vj->vi', np.linalg.inv(A[:, :, :3]), Pdm - Plbs)      # rest-space offset
    mag = np.linalg.norm(crest, axis=1)
    cidx = np.where(mag > args.corr_min)[0]
    cscale = float(np.abs(crest[cidx]).max() / 127.0)
    cvec = np.round(crest[cidx] / cscale).astype(np.int8)

    # ── self-test vectors for the TypeScript port ──
    def case(target, weight, t, arm, leg):
        P = V.copy()
        if target:
            ti, tv = human_target(hmeta, hbuf, target)
            P[ti] += tv * weight
        Jc = sk2.compute_joints(P)
        Mc = sk2.pose(Jc, t, arm, leg)
        S = sk2.skin(Mc, P, t)
        vs = np.unique(np.concatenate([np.arange(0, nV, 331), sk2.cidx[::max(1, len(sk2.cidx) // 24)]]))
        est = sk2.estimate_abduction(P, Jc)
        rnd = lambda a: [round(float(x), 5) for x in np.asarray(a).ravel()]
        return dict(target=target, weight=weight, t=t, arm=arm, leg=leg, verts=vs.tolist(), pos=rnd(S[vs]),
                    restJoints=rnd(Jc), joints=rnd(sk2.pose_joints(Mc, Jc)), capsules=rnd(sk2.capsules(Mc, Jc, P)),
                    checksum=round(float(np.abs(S).sum()), 3), estimate=[round(float(est[0]), 4), round(float(est[1]), 4)])

    meta, blob = write(cidx, cvec, cscale)
    sk2 = Skel(meta, blob)
    fat = 'macrodetails/universal-male-young-averagemuscle-maxweight'
    tests = [case(None, 0, 1.0, 0.0, 0.0), case(None, 0, 0.6, 9.0, 3.0), case(fat, 1.0, 1.0, 14.0, 5.0)]
    if args.selftest:
        Path(args.selftest).write_text(json.dumps(dict(
            note='numpy reference vectors for src/__tests__/skeleton.test.ts, written by tools/mh/build_skeleton.py',
            cases=tests), separators=(',', ':')) + '\n')

    json_size = (Path(args.out) / 'skeleton.json').stat().st_size
    print(f'bones {len(kept)} (of {len(rig.names)}), joints {len(joints)}, capsules {len(caps)}')
    print(f'weights lost by 4-influence truncation: max {lost.max():.4f}, verts > 1%: {(lost > 0.01).sum()}')
    print(f'single-influence verts: {(q4[:, 0] == 255).sum()} / {nV}')
    print(f'corrective: {len(cidx)} verts, max {mag.max() * 100:.2f} mm, step {cscale * 100:.4f} mm')
    print('probes:', {k: len(v) for k, v in probes.items()})
    print(f'skeleton.bin {len(blob) / 1024:.1f} KB, skeleton.json {json_size / 1024:.1f} KB, total {(len(blob) + json_size) / 1024:.1f} KB')
    print('estimate (default body) arm/leg deg:', tests[0]['estimate'], ' obese male:', tests[2]['estimate'])
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--rig', default=SCRATCH + '/mhdata/x/package/src/json/rigs/default.json')
    ap.add_argument('--weights', default=SCRATCH + '/mh_raw/default_weights.mhw')
    ap.add_argument('--human', default=str(ROOT / 'public' / 'human'), help='directory with human.bin / human.json')
    ap.add_argument('--out', default=str(ROOT / 'public' / 'human'))
    ap.add_argument('--selftest', default=str(ROOT / 'src' / '__tests__' / 'skeleton.selftest.json'),
                    help='where to write the numpy reference vectors used by the vitest suite ("" = skip)')
    ap.add_argument('--mush-iters', type=int, default=10, help='delta-mush iterations for the baked pose corrective')
    ap.add_argument('--corr-min', type=float, default=0.004, help='drop corrective offsets shorter than this (dm)')
    return build(ap.parse_args())


if __name__ == '__main__':
    sys.exit(main())
