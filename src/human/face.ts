/**
 * Face personalisation: MediaPipe Face Landmarker (478 points) ↔ MakeHuman head.
 *  - correspondences between MediaPipe indices and MakeHuman rest-pose positions (decimetres, x = subject's left)
 *  - thin-plate-spline mapping for projecting a selfie onto the face
 *  - frontal proportions used to fit face-shape targets
 */
import { applyTargets, resolveModifier, type HumanData } from './engine';

/** [mediapipeIndex, mhX, mhY] – MakeHuman rest coordinates of the same facial feature. */
export const FACE_CORR: [number, number, number][] = [
  [33, -0.463, 7.279], [133, -0.154, 7.275], [362, 0.154, 7.275], [263, 0.463, 7.279],
  [159, -0.3, 7.36], [145, -0.3, 7.19], [386, 0.3, 7.36], [374, 0.3, 7.19],
  [70, -0.55, 7.46], [105, -0.32, 7.53], [107, -0.12, 7.49], [300, 0.55, 7.46], [334, 0.32, 7.53], [336, 0.12, 7.49],
  [1, 0, 6.91], [2, 0, 6.79], [98, -0.17, 6.77], [327, 0.17, 6.77],
  [61, -0.24, 6.575], [291, 0.24, 6.575], [0, 0, 6.7], [17, 0, 6.46], [13, 0, 6.61],
  [152, 0, 6.14], [10, 0, 7.86], [109, -0.33, 7.8], [338, 0.33, 7.8], [67, -0.55, 7.72], [297, 0.55, 7.72],
  [234, -0.7, 7.12], [454, 0.7, 7.12], [127, -0.7, 7.45], [356, 0.7, 7.45], [93, -0.67, 6.9], [323, 0.67, 6.9],
  [132, -0.61, 6.66], [361, 0.61, 6.66], [58, -0.52, 6.46], [288, 0.52, 6.46], [172, -0.44, 6.33], [397, 0.44, 6.33],
  [136, -0.33, 6.24], [365, 0.33, 6.24], [149, -0.2, 6.17], [378, 0.2, 6.17],
];

/** Face oval (MediaPipe indices, ordered) – used as the texture blend boundary. */
export const OVAL = [10, 338, 297, 356, 454, 323, 361, 288, 397, 365, 378, 152, 149, 136, 172, 58, 132, 93, 234, 127, 67, 109];

// ───────────────────────── thin plate spline 2D → 2D ─────────────────────────

export interface Tps {
  cx: Float64Array;
  cy: Float64Array;
  wx: Float64Array; // n + 3
  wy: Float64Array;
}

const U = (r2: number) => (r2 < 1e-12 ? 0 : r2 * Math.log(r2) * 0.5);

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

export function fitTps(src: [number, number][], dst: [number, number][], lambda = 1e-4): Tps {
  const n = src.length;
  const N = n + 3;
  const A: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = src[i][0] - src[j][0];
      const dy = src[i][1] - src[j][1];
      A[i][j] = U(dx * dx + dy * dy) + (i === j ? lambda : 0);
    }
    A[i][n] = 1;
    A[i][n + 1] = src[i][0];
    A[i][n + 2] = src[i][1];
    A[n][i] = 1;
    A[n + 1][i] = src[i][0];
    A[n + 2][i] = src[i][1];
  }
  const bx = [...dst.map((d) => d[0]), 0, 0, 0];
  const by = [...dst.map((d) => d[1]), 0, 0, 0];
  return {
    cx: Float64Array.from(src.map((s) => s[0])),
    cy: Float64Array.from(src.map((s) => s[1])),
    wx: Float64Array.from(solve(A, bx)),
    wy: Float64Array.from(solve(A, by)),
  };
}

export function evalTps(t: Tps, x: number, y: number): [number, number] {
  const n = t.cx.length;
  let u = t.wx[n] + t.wx[n + 1] * x + t.wx[n + 2] * y;
  let v = t.wy[n] + t.wy[n + 1] * x + t.wy[n + 2] * y;
  for (let i = 0; i < n; i++) {
    const dx = x - t.cx[i];
    const dy = y - t.cy[i];
    const k = U(dx * dx + dy * dy);
    u += t.wx[i] * k;
    v += t.wy[i] * k;
  }
  return [u, v];
}

function pointInPoly(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function distToPoly(x: number, y: number, poly: [number, number][]) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const vx = bx - ax,
      vy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
    d = Math.min(d, Math.hypot(x - ax - vx * t, y - ay - vy * t));
  }
  return d;
}

/**
 * Per-vertex face UVs from REST positions (decimetres) of the subdivided body.
 * `lm` = flattened [mpIndex, u, v, …] with u,v in [0,1] texture space (v down).
 */
export function faceUVs(rest: Float32Array, restNormals: Float32Array, lm: number[]): { uv: Float32Array; w: Float32Array } {
  const map = new Map<number, [number, number]>();
  for (let i = 0; i < lm.length; i += 3) map.set(lm[i], [lm[i + 1], lm[i + 2]]);
  const src: [number, number][] = [];
  const dst: [number, number][] = [];
  for (const [mp, x, y] of FACE_CORR) {
    const p = map.get(mp);
    if (!p) continue;
    src.push([x, y]);
    dst.push(p);
  }
  const tps = fitTps(src, dst);
  const oval: [number, number][] = OVAL.map((mp) => {
    const c = FACE_CORR.find((f) => f[0] === mp)!;
    return [c[1], c[2]];
  });
  const n = rest.length / 3;
  const uv = new Float32Array(n * 2);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = rest[i * 3],
      y = rest[i * 3 + 1],
      z = rest[i * 3 + 2];
    if (y < 5.95 || y > 8.1 || z < 0.85 || restNormals[i * 3 + 2] < 0.15) continue;
    const inside = pointInPoly(x, y, oval);
    const d = distToPoly(x, y, oval);
    const edge = inside ? Math.min(1, d / 0.12) : 0;
    if (edge <= 0) continue;
    const [u, v] = evalTps(tps, x, y);
    uv[i * 2] = u;
    uv[i * 2 + 1] = 1 - v;
    const facing = Math.min(1, Math.max(0, (restNormals[i * 3 + 2] - 0.15) / 0.35));
    w[i] = edge * edge * (3 - 2 * edge) * facing;
  }
  return { uv, w };
}

// ───────────────────────── face-shape fitting ─────────────────────────

/** Frontal proportions from 2D points (any units). */
export function faceRatios(p: (mp: number) => [number, number]): number[] {
  const d = (a: number, b: number) => Math.hypot(p(a)[0] - p(b)[0], p(a)[1] - p(b)[1]);
  const mid = (a: number, b: number): [number, number] => [(p(a)[0] + p(b)[0]) / 2, (p(a)[1] + p(b)[1]) / 2];
  const dd = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const FW = d(234, 454);
  const FH = d(10, 152);
  const eyeC = mid(133, 362);
  return [
    d(133, 362) / FW, // eye spacing
    (d(33, 133) + d(362, 263)) / 2 / FW, // eye width
    d(98, 327) / FW, // nose width
    d(61, 291) / FW, // mouth width
    FH / FW, // face height
    dd(eyeC, p(2)) / FH, // nose length
    d(2, 13) / FH, // nose→mouth
    d(17, 152) / FH, // chin height
    d(172, 397) / FW, // jaw width
    dd(mid(105, 334), mid(159, 386)) / FH, // brow height above eyes
  ];
}

/** Mean proportions of the MediaPipe canonical face model (population average) – used to remove systematic bias. */
export const MP_MEAN_RATIOS = [0.2422, 0.169, 0.1834, 0.3205, 1.1524, 0.2646, 0.1079, 0.2286, 0.7751, 0.1214];

export const RATIO_MODS: string[][] = [
  ['eyes/l-eye-trans|out|in', 'eyes/r-eye-trans|out|in'], // wider / narrower eye spacing
  ['eyes/l-eye-scale', 'eyes/r-eye-scale'],
  ['nose/nose-scale-horiz'],
  ['mouth/mouth-scale-horiz'],
  ['head/head-scale-vert'],
  ['nose/nose-scale-vert'],
  ['mouth/mouth-trans|up|down'],
  ['chin/chin-height'],
  ['chin/chin-width'],
  ['eyebrows/eyebrows-trans|up|down'],
];
export const RATIO_LABEL = ['расстояние между глазами', 'ширина глаз', 'ширина носа', 'ширина рта', 'высота лица', 'длина носа', 'нос–рот', 'высота подбородка', 'ширина челюсти', 'высота бровей'];

/** MakeHuman vertex index for each correspondence (front-most vertex near the rest x,y). */
export function corrVertices(data: HumanData): Map<number, number> {
  const out = new Map<number, number>();
  const body = data.faces.body;
  const used = new Uint8Array(data.nVerts);
  for (let i = 0; i < body.length; i++) used[body[i]] = 1;
  for (const [mp, x, y] of FACE_CORR) {
    let best = -1,
      bestScore = -Infinity;
    for (let v = 0; v < data.nVerts; v++) {
      if (!used[v]) continue;
      const vx = data.base[v * 3],
        vy = data.base[v * 3 + 1],
        vz = data.base[v * 3 + 2];
      if (vy < 5.9 || vz < 0.6) continue;
      const dxy = Math.hypot(vx - x, vy - y);
      if (dxy > 0.06) continue;
      const score = vz - dxy * 4;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best >= 0) out.set(mp, best);
  }
  return out;
}

/** Ridge least-squares fit of face-shape modifiers so that the head reproduces the selfie proportions. */
export function fitFace(data: HumanData, baseWeights: Map<string, number>, start: Record<string, number>, target: number[]): Record<string, number> {
  const corr = corrVertices(data);
  const ratiosOf = (pos: Float32Array) =>
    faceRatios((mp) => {
      const v = corr.get(mp)!;
      return [pos[v * 3], pos[v * 3 + 1]];
    });
  const withMods = (m: Record<string, number>) => {
    const w = new Map(baseWeights);
    for (const [k, v] of Object.entries(m)) {
      // eye spacing: l-eye out = +x, r-eye out = −x → both "out" for wider spacing
      const r = resolveModifier(data, k, v);
      if (r) w.set(r[0], (w.get(r[0]) ?? 0) + r[1]);
    }
    return applyTargets(data, w);
  };
  const keysFor = (i: number) => RATIO_MODS[i];
  // relative fitting: the user's deviation from the average face is applied to the MakeHuman average head
  const ref = ratiosOf(withMods({}));
  const goal = target.map((t, i) => ref[i] * Math.max(0.75, Math.min(1.25, t / MP_MEAN_RATIOS[i])));
  target = goal;
  let cur: Record<string, number> = { ...start };
  for (let it = 0; it < 3; it++) {
    const r0 = ratiosOf(withMods(cur));
    const J: number[][] = target.map(() => new Array(RATIO_MODS.length).fill(0));
    const h = 0.4;
    for (let j = 0; j < RATIO_MODS.length; j++) {
      const m = { ...cur };
      for (const k of keysFor(j)) m[k] = (m[k] ?? 0) + h;
      const r1 = ratiosOf(withMods(m));
      for (let i = 0; i < target.length; i++) J[i][j] = (r1[i] - r0[i]) / h;
    }
    // (JᵀJ + λI) Δ = Jᵀ (t − r0)
    const n = RATIO_MODS.length;
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    for (let i = 0; i < target.length; i++) {
      const e = (target[i] - r0[i]) / Math.max(1e-3, Math.abs(r0[i]));
      for (let a = 0; a < n; a++) {
        const ja = J[i][a] / Math.max(1e-3, Math.abs(r0[i]));
        b[a] += ja * e;
        for (let c = 0; c < n; c++) A[a][c] += ja * (J[i][c] / Math.max(1e-3, Math.abs(r0[i])));
      }
    }
    for (let a = 0; a < n; a++) A[a][a] += 0.05;
    const delta = solve(A, b);
    const next = { ...cur };
    for (let j = 0; j < n; j++) for (const k of keysFor(j)) next[k] = Math.max(-0.7, Math.min(0.7, (next[k] ?? 0) + delta[j]));
    cur = next;
  }
  // eye spacing keys need mirrored sign for the right eye: l-eye-trans "out" moves +x, r-eye-trans "out" moves −x –
  // MakeHuman names both "out" as away from the nose, so the same sign is correct.
  return cur;
}
