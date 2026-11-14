/**
 * Realistic human mesh engine (MakeHuman CC0 base mesh + morph targets).
 * Base units are decimetres; output is metres, feet on y = 0.
 */

export interface HumanMeta {
  vectorScale: number;
  bboxMin: number[];
  bboxMax: number[];
  layout: { positions: [number, number]; faces: Record<string, [number, number]> };
  targets: { name: string; idx: number; vec: number; n: number }[];
}

export interface Target {
  idx: Uint16Array;
  vec: Int16Array;
}

export interface HumanData {
  base: Float32Array;
  nVerts: number;
  faces: Record<string, Uint16Array>; // quads
  targets: Map<string, Target>;
  scale: number;
}

export async function loadHumanData(baseUrl: string): Promise<HumanData> {
  const [metaRes, binRes] = await Promise.all([fetch(baseUrl + 'human.json'), fetch(baseUrl + 'human.bin')]);
  if (!metaRes.ok || !binRes.ok) throw new Error('human asset not found');
  const meta = (await metaRes.json()) as HumanMeta;
  const buf = await binRes.arrayBuffer();
  const [pOff, nVerts] = meta.layout.positions;
  const base = new Float32Array(buf, pOff, nVerts * 3);
  const faces: Record<string, Uint16Array> = {};
  for (const [g, [off, n]] of Object.entries(meta.layout.faces)) faces[g] = new Uint16Array(buf, off, n * 4);
  const targets = new Map<string, Target>();
  for (const t of meta.targets) targets.set(t.name, { idx: new Uint16Array(buf, t.idx, t.n), vec: new Int16Array(buf, t.vec, t.n * 3) });
  return { base, nVerts, faces, targets, scale: meta.vectorScale };
}

// ───────────────────────── Parameters ─────────────────────────

export interface MacroParams {
  gender: number; // 0 female … 1 male
  age: number; // MakeHuman age 0..1 (0.5 = 25 years)
  muscle: number; // 0..1 (0.5 average)
  weight: number; // 0..1 (0.5 average)
  breastSize: number; // 0..1 (0.5 average cup)
  ethnic: { african: number; asian: number; caucasian: number };
}

/** Signed modifier values: "group/name" → v. v>0 uses "-incr" target (or the plain target), v<0 uses "-decr". */
export type Modifiers = Record<string, number>;

const PAIRS: [string, string][] = [
  ['incr', 'decr'],
  ['up', 'down'],
  ['out', 'in'],
  ['forward', 'backward'],
  ['convex', 'concave'],
  ['uncompress', 'compress'],
];

export function resolveModifier(data: HumanData, key: string, v: number): [string, number] | null {
  if (Math.abs(v) < 1e-4) return null;
  if (key.includes('|')) {
    const [base, pos, neg] = key.split('|');
    const name = `${base}-${v > 0 ? pos : neg}`;
    return data.targets.has(name) ? [name, Math.abs(v)] : null;
  }
  if (data.targets.has(key)) return [key, v];
  for (const [pos, neg] of PAIRS) {
    const name = `${key}-${v > 0 ? pos : neg}`;
    if (data.targets.has(name)) return [name, Math.abs(v)];
  }
  return null;
}

export function macroWeights(p: MacroParams): Map<string, number> {
  const out = new Map<string, number>();
  const g: [string, number][] = [
    ['male', p.gender],
    ['female', 1 - p.gender],
  ];
  const oldV = Math.max(0, p.age * 2 - 1);
  const a: [string, number][] = [
    ['young', p.age >= 0.5 ? 1 - oldV : 1],
    ['old', p.age >= 0.5 ? oldV : 0],
  ];
  const m: [string, number][] = [
    ['maxmuscle', Math.max(0, p.muscle * 2 - 1)],
    ['minmuscle', Math.max(0, 1 - p.muscle * 2)],
  ];
  m.push(['averagemuscle', 1 - m[0][1] - m[1][1]]);
  const w: [string, number][] = [
    ['maxweight', Math.max(0, p.weight * 2 - 1)],
    ['minweight', Math.max(0, 1 - p.weight * 2)],
  ];
  w.push(['averageweight', 1 - w[0][1] - w[1][1]]);
  for (const [gn, gv] of g)
    for (const [an, av] of a)
      for (const [mn, mv] of m)
        for (const [wn, wv] of w) {
          const f = gv * av * mv * wv;
          if (f > 1e-5) out.set(`macrodetails/universal-${gn}-${an}-${mn}-${wn}`, f);
        }
  const eth = p.ethnic;
  const es = eth.african + eth.asian + eth.caucasian || 1;
  for (const e of ['african', 'asian', 'caucasian'] as const)
    for (const [gn, gv] of g)
      for (const [an, av] of a) {
        const f = (eth[e] / es) * gv * av;
        if (f > 1e-5) out.set(`macrodetails/${e}-${gn}-${an}`, f);
      }
  // breasts (female only, young targets)
  const fem = 1 - p.gender;
  if (fem > 1e-3) {
    const cups: [string, number][] = [
      ['maxcup', Math.max(0, p.breastSize * 2 - 1)],
      ['mincup', Math.max(0, 1 - p.breastSize * 2)],
    ];
    for (const [mn, mv] of m)
      for (const [wn, wv] of w)
        for (const [cn, cv] of cups) {
          const f = fem * mv * wv * cv;
          if (f > 1e-5) out.set(`breast/female-young-${mn}-${wn}-${cn}-averagefirmness`, f);
        }
  }
  return out;
}

/** Applies macro + modifier targets to the base mesh. Returns positions in decimetres (all vertices). */
export function applyTargets(data: HumanData, weights: Map<string, number>, out?: Float32Array): Float32Array {
  const pos = out ?? new Float32Array(data.base.length);
  pos.set(data.base);
  const s = data.scale;
  for (const [name, w] of weights) {
    const t = data.targets.get(name);
    if (!t) continue;
    const k = w * s;
    const { idx, vec } = t;
    for (let i = 0; i < idx.length; i++) {
      const j = idx[i] * 3;
      pos[j] += vec[i * 3] * k;
      pos[j + 1] += vec[i * 3 + 1] * k;
      pos[j + 2] += vec[i * 3 + 2] * k;
    }
  }
  return pos;
}

export function addModifiers(data: HumanData, weights: Map<string, number>, mods: Modifiers) {
  for (const [k, v] of Object.entries(mods)) {
    const r = resolveModifier(data, k, v);
    if (r) weights.set(r[0], (weights.get(r[0]) ?? 0) + r[1]);
  }
  return weights;
}

// ───────────────────────── Measurements (MakeHuman ruler loops) ─────────────────────────

export const RULER: Record<string, number[]> = {
  neck: [7514, 10358, 7631, 7496, 7488, 7489, 7474, 7475, 7531, 7537, 7543, 7549, 7555, 7561, 7743, 7722, 856, 1030, 1051, 850, 844, 838, 832, 826, 820, 756, 755, 770, 769, 777, 929, 3690, 804, 800, 808, 801, 799, 803, 7513, 7515, 7521, 7514],
  arm: [8383, 8393, 8392, 8391, 8390, 8394, 8395, 8399, 10455, 10516, 8396, 8397, 8398, 8388, 8387, 8386, 10431, 8385, 8384, 8389],
  chest: [8439, 8455, 8462, 8446, 8478, 8494, 8557, 8510, 8526, 8542, 10720, 10601, 10603, 10602, 10612, 10611, 10610, 10613, 10604, 10605, 10606, 3942, 3941, 3940, 3950, 3947, 3948, 3949, 3938, 3939, 3937, 4065, 1870, 1854, 1838, 1885, 1822, 1806, 1774, 1790, 1783, 1767, 1799, 8471],
  underbust: [10750, 10744, 10724, 10725, 10748, 10722, 10640, 10642, 10641, 10651, 10650, 10649, 10652, 10643, 10644, 10645, 10646, 10647, 10648, 3988, 3987, 3986, 3985, 3984, 3983, 3982, 3992, 3989, 3990, 3991, 3980, 3981, 3979, 4067, 4098, 4073, 4072, 4094, 4100, 4082, 4088],
  waist: [4121, 10760, 10757, 10777, 10776, 10779, 10780, 10778, 10781, 10771, 10773, 10772, 10775, 10774, 10814, 10834, 10816, 10817, 10818, 10819, 10820, 10821, 4181, 4180, 4179, 4178, 4177, 4176, 4175, 4196, 4173, 4131, 4132, 4129, 4130, 4128, 4138, 4135, 4137, 4136, 4133, 4134, 4108, 4113, 4118, 4121],
  hips: [4341, 10968, 10969, 10971, 10970, 10967, 10928, 10927, 10925, 10926, 10923, 10924, 10868, 10875, 10861, 10862, 4228, 4227, 4226, 4242, 4234, 4294, 4293, 4296, 4295, 4297, 4298, 4342, 4345, 4346, 4344, 4343, 4361, 4341],
  thigh: [11071, 11080, 11081, 11086, 11076, 11077, 11074, 11075, 11072, 11073, 11069, 11070, 11087, 11085, 11084, 12994, 11083, 11082, 11079, 11071],
  calf: [11339, 11336, 11353, 11351, 11350, 13008, 11349, 11348, 11345, 11337, 11344, 11346, 11347, 11352, 11342, 11343, 11340, 11341, 11338, 11339],
  wrist: [10208, 10211, 10212, 10216, 10471, 10533, 10213, 10214, 10215, 10205, 10204, 10203, 10437, 10202, 10201, 10206, 10200, 10210, 10209, 10208],
};

export const RULER_TARGET: Record<string, string> = {
  neck: 'measure/measure-neck-circ',
  arm: 'measure/measure-upperarm-circ',
  chest: 'measure/measure-bust-circ',
  underbust: 'measure/measure-underbust-circ',
  waist: 'measure/measure-waist-circ',
  hips: 'measure/measure-hips-circ',
  thigh: 'measure/measure-thigh-circ',
  calf: 'measure/measure-calf-circ',
  wrist: 'measure/measure-wrist-circ',
};

/** Loop length in the units of `pos` (closed polyline). */
export function loopLength(pos: Float32Array, loop: number[], scale = 1) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3;
    const b = loop[(i + 1) % loop.length] * 3;
    if (loop[i] === loop[(i + 1) % loop.length]) continue;
    s += Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
  }
  return s * scale;
}

// ───────────────────────── Catmull–Clark subdivision ─────────────────────────

export interface SubdivTopo {
  verts: Uint32Array; // original vertex indices used by this group (local → global)
  nV: number;
  nE: number;
  nF: number;
  quads: Uint32Array; // local quad indices
  edges: Uint32Array; // [v0, v1] local
  edgeFaces: Int32Array; // [f0, f1] (f1 = -1 boundary)
  faceEdges: Uint32Array; // 4 per face
  // vertex stencil (CSR) – incident faces and edges
  vfPtr: Uint32Array;
  vf: Uint32Array;
  vePtr: Uint32Array;
  ve: Uint32Array;
  boundary: Uint8Array;
  outQuads: Uint32Array; // subdivided quads (indices into subdivided vertex array)
  outTris: Uint32Array;
}

export function buildSubdiv(quadsGlobal: Uint16Array): SubdivTopo {
  const map = new Map<number, number>();
  const verts: number[] = [];
  const nF = quadsGlobal.length / 4;
  const quads = new Uint32Array(quadsGlobal.length);
  for (let i = 0; i < quadsGlobal.length; i++) {
    const g = quadsGlobal[i];
    let l = map.get(g);
    if (l === undefined) {
      l = verts.length;
      verts.push(g);
      map.set(g, l);
    }
    quads[i] = l;
  }
  const nV = verts.length;
  const emap = new Map<number, number>();
  const edges: number[] = [];
  const edgeFaces: number[] = [];
  const faceEdges = new Uint32Array(nF * 4);
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 4; k++) {
      let a = quads[f * 4 + k];
      let b = quads[f * 4 + ((k + 1) & 3)];
      if (a === b) {
        // degenerate (triangle stored as quad)
        b = quads[f * 4 + ((k + 2) & 3)];
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * 1048576 + hi;
      let e = emap.get(key);
      if (e === undefined) {
        e = edges.length / 2;
        edges.push(lo, hi);
        edgeFaces.push(f, -1);
        emap.set(key, e);
      } else if (edgeFaces[e * 2 + 1] === -1 && edgeFaces[e * 2] !== f) edgeFaces[e * 2 + 1] = f;
      faceEdges[f * 4 + k] = e;
      void a;
    }
  }
  const nE = edges.length / 2;
  // vertex → faces / edges CSR
  const vfCount = new Uint32Array(nV + 1);
  const veCount = new Uint32Array(nV + 1);
  for (let f = 0; f < nF; f++) {
    const seen = new Set<number>();
    for (let k = 0; k < 4; k++) {
      const v = quads[f * 4 + k];
      if (!seen.has(v)) {
        seen.add(v);
        vfCount[v + 1]++;
      }
    }
  }
  for (let e = 0; e < nE; e++) {
    veCount[edges[e * 2] + 1]++;
    veCount[edges[e * 2 + 1] + 1]++;
  }
  for (let i = 0; i < nV; i++) {
    vfCount[i + 1] += vfCount[i];
    veCount[i + 1] += veCount[i];
  }
  const vf = new Uint32Array(vfCount[nV]);
  const ve = new Uint32Array(veCount[nV]);
  const vfFill = vfCount.slice(0, nV);
  const veFill = veCount.slice(0, nV);
  for (let f = 0; f < nF; f++) {
    const seen = new Set<number>();
    for (let k = 0; k < 4; k++) {
      const v = quads[f * 4 + k];
      if (!seen.has(v)) {
        seen.add(v);
        vf[vfFill[v]++] = f;
      }
    }
  }
  const boundary = new Uint8Array(nV);
  for (let e = 0; e < nE; e++) {
    const a = edges[e * 2];
    const b = edges[e * 2 + 1];
    ve[veFill[a]++] = e;
    ve[veFill[b]++] = e;
    if (edgeFaces[e * 2 + 1] === -1) {
      boundary[a] = 1;
      boundary[b] = 1;
    }
  }
  // output topology
  const outQuads = new Uint32Array(nF * 16);
  const EOFF = nV;
  const FOFF = nV + nE;
  for (let f = 0; f < nF; f++) {
    const v = [quads[f * 4], quads[f * 4 + 1], quads[f * 4 + 2], quads[f * 4 + 3]];
    const e = [faceEdges[f * 4], faceEdges[f * 4 + 1], faceEdges[f * 4 + 2], faceEdges[f * 4 + 3]];
    const fc = FOFF + f;
    for (let k = 0; k < 4; k++) {
      const o = f * 16 + k * 4;
      outQuads[o] = v[k];
      outQuads[o + 1] = EOFF + e[k];
      outQuads[o + 2] = fc;
      outQuads[o + 3] = EOFF + e[(k + 3) & 3];
    }
  }
  const outTris = new Uint32Array(nF * 4 * 6);
  for (let q = 0; q < nF * 4; q++) {
    const a = outQuads[q * 4],
      b = outQuads[q * 4 + 1],
      c = outQuads[q * 4 + 2],
      d = outQuads[q * 4 + 3];
    outTris.set([a, b, c, a, c, d], q * 6);
  }
  return {
    verts: Uint32Array.from(verts),
    nV,
    nE,
    nF,
    quads,
    edges: Uint32Array.from(edges),
    edgeFaces: Int32Array.from(edgeFaces),
    faceEdges,
    vfPtr: vfCount,
    vf,
    vePtr: veCount,
    ve,
    boundary,
    outQuads,
    outTris,
  };
}

/** One Catmull–Clark step. `src` is a global position array; result is local subdivided positions. */
export function subdivide(t: SubdivTopo, src: Float32Array, xf: (x: number, y: number, z: number, o: Float32Array, i: number) => void): Float32Array {
  const { nV, nE, nF } = t;
  const P = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) xf(src[t.verts[i] * 3], src[t.verts[i] * 3 + 1], src[t.verts[i] * 3 + 2], P, i * 3);
  const out = new Float32Array((nV + nE + nF) * 3);
  const FO = (nV + nE) * 3;
  // face points
  for (let f = 0; f < nF; f++) {
    let x = 0,
      y = 0,
      z = 0;
    for (let k = 0; k < 4; k++) {
      const v = t.quads[f * 4 + k] * 3;
      x += P[v];
      y += P[v + 1];
      z += P[v + 2];
    }
    out[FO + f * 3] = x / 4;
    out[FO + f * 3 + 1] = y / 4;
    out[FO + f * 3 + 2] = z / 4;
  }
  // edge points
  const EO = nV * 3;
  for (let e = 0; e < nE; e++) {
    const a = t.edges[e * 2] * 3;
    const b = t.edges[e * 2 + 1] * 3;
    const f0 = t.edgeFaces[e * 2];
    const f1 = t.edgeFaces[e * 2 + 1];
    if (f1 < 0) {
      out[EO + e * 3] = (P[a] + P[b]) / 2;
      out[EO + e * 3 + 1] = (P[a + 1] + P[b + 1]) / 2;
      out[EO + e * 3 + 2] = (P[a + 2] + P[b + 2]) / 2;
    } else {
      out[EO + e * 3] = (P[a] + P[b] + out[FO + f0 * 3] + out[FO + f1 * 3]) / 4;
      out[EO + e * 3 + 1] = (P[a + 1] + P[b + 1] + out[FO + f0 * 3 + 1] + out[FO + f1 * 3 + 1]) / 4;
      out[EO + e * 3 + 2] = (P[a + 2] + P[b + 2] + out[FO + f0 * 3 + 2] + out[FO + f1 * 3 + 2]) / 4;
    }
  }
  // vertex points
  for (let v = 0; v < nV; v++) {
    const p = v * 3;
    if (t.boundary[v]) {
      let sx = 0,
        sy = 0,
        sz = 0,
        c = 0;
      for (let j = t.vePtr[v]; j < t.vePtr[v + 1]; j++) {
        const e = t.ve[j];
        if (t.edgeFaces[e * 2 + 1] !== -1) continue;
        const o = (t.edges[e * 2] === v ? t.edges[e * 2 + 1] : t.edges[e * 2]) * 3;
        sx += P[o];
        sy += P[o + 1];
        sz += P[o + 2];
        c++;
      }
      if (c === 2) {
        out[p] = (6 * P[p] + sx) / 8;
        out[p + 1] = (6 * P[p + 1] + sy) / 8;
        out[p + 2] = (6 * P[p + 2] + sz) / 8;
      } else {
        out[p] = P[p];
        out[p + 1] = P[p + 1];
        out[p + 2] = P[p + 2];
      }
      continue;
    }
    const n = t.vePtr[v + 1] - t.vePtr[v];
    let qx = 0,
      qy = 0,
      qz = 0;
    const nf = t.vfPtr[v + 1] - t.vfPtr[v];
    for (let j = t.vfPtr[v]; j < t.vfPtr[v + 1]; j++) {
      const f = t.vf[j] * 3;
      qx += out[FO + f];
      qy += out[FO + f + 1];
      qz += out[FO + f + 2];
    }
    qx /= nf;
    qy /= nf;
    qz /= nf;
    let rx = 0,
      ry = 0,
      rz = 0;
    for (let j = t.vePtr[v]; j < t.vePtr[v + 1]; j++) {
      const e = t.ve[j];
      const a = t.edges[e * 2] * 3;
      const b = t.edges[e * 2 + 1] * 3;
      rx += (P[a] + P[b]) / 2;
      ry += (P[a + 1] + P[b + 1]) / 2;
      rz += (P[a + 2] + P[b + 2]) / 2;
    }
    rx /= n;
    ry /= n;
    rz /= n;
    out[p] = (qx + 2 * rx + (n - 3) * P[p]) / n;
    out[p + 1] = (qy + 2 * ry + (n - 3) * P[p + 1]) / n;
    out[p + 2] = (qz + 2 * rz + (n - 3) * P[p + 2]) / n;
  }
  return out;
}

export function computeNormals(pos: Float32Array, tris: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3,
      b = tris[i + 1] * 3,
      c = tris[i + 2] * 3;
    const ux = pos[b] - pos[a],
      uy = pos[b + 1] - pos[a + 1],
      uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a],
      vy = pos[c + 1] - pos[a + 1],
      vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}
