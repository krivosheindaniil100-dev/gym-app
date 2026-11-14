/**
 * Proxies – real geometry for hair, eyebrows, eyelashes and eyes (MakeHuman CC0 system assets) that follows every
 * morph and every pose of the base mesh.  Built by tools/mh/build_proxies.py → public/human/proxies.{bin,json}.
 *
 * Conventions
 *  - Units: decimetres (MakeHuman), same space as `FitResult.pos`; y up, +z = front, +x = the model's LEFT.
 *  - `base` always means ALL 19158 base vertices (helpers included – several proxies hang on helper geometry).
 *  - UVs are OpenGL style (v up) → three.js textures with the default flipY = true.
 *  - No DOM / WebGL: safe inside a Web Worker. No allocation after loadProxies() when `out` buffers are reused.
 *
 * Fitting (MakeHuman shared/proxy.py, Proxy.getCoords):
 *      p = w0·V[r0] + w1·V[r1] + w2·V[r2] + R · M · offset
 *  M = diag(|V[a]-V[b]| / den) per axis – the head's x / y / z extent relative to the human the proxy was modelled on
 *      (x_scale / y_scale / z_scale of the .mhclo file), measured on the REST pose like MakeHuman does.
 *  R = identity for an unposed body (exact MakeHuman result). For a posed body (opts.rest given) R is the rigid
 *      rotation rest → posed of the head (Kabsch fit over 48 skull vertices), blended per vertex with the rotation of
 *      the upper torso by the vertex's "headness" (hair lying on the shoulders follows the shoulders).
 *      Measured against MakeHuman's own route (fit in rest pose, then skin the proxy with its interpolated bone
 *      weights) for a 15° head tilt: ≤ 1.8 mm max / ≤ 0.2 mm mean. Offsets expressed in the local frame of each
 *      reference triangle were tried and rejected: 6–40 mm errors, even without a pose (morphs tilt the triangles).
 */

export type ProxyKind = 'hair' | 'eyebrows' | 'eyelashes' | 'eyes' | 'cornea';

/** three.js material recommendation, see proxies.json / README notes in the builder. */
export interface ProxyRenderHints {
  side: 'front' | 'double';
  transparent: boolean;
  depthWrite: boolean;
  renderOrder: number;
  alphaTest?: number;
  alphaToCoverage?: boolean;
  blending?: 'additive';
  color?: number[];
  roughness?: number;
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  note?: string;
}

export interface ProxyJson {
  name: string;
  kind: ProxyKind;
  label: string;
  source: string;
  fitCount: number;
  vertexCount: number;
  triCount: number;
  ref: number;
  wgt: number;
  off: number;
  hw: number;
  dup: number;
  uv: number;
  idx: number;
  /** optional per-vertex extras (hair only) */
  ao?: number;
  dir?: number;
  scale: [number, number, number][];
  render: ProxyRenderHints;
  texture: string | null;
  textures?: Record<string, string>;
  tint: number[];
  tags?: string[];
}

export interface ProxiesJson {
  version: number;
  unit: string;
  baseVertexCount: number;
  weightScale: number;
  offsetScale: number;
  anchors: { head: number[]; torso: number[] };
  deleteVerts: number[];
  proxies: ProxyJson[];
}

/** Data shared by all proxies of one asset file. */
export interface ProxyShared {
  baseVertexCount: number;
  weightScale: number;
  offsetScale: number;
  headAnchor: Uint16Array;
  torsoAnchor: Uint16Array;
  /** base vertices whose faces must be hidden under a proxy (MakeHuman delete_verts) – empty for the shipped set */
  deleteVerts: Uint16Array;
}

export interface Proxy {
  name: string;
  kind: ProxyKind;
  label: string;
  tags: string[];
  /** render vertices = fitCount canonical vertices followed by uv-seam duplicates */
  vertexCount: number;
  fitCount: number;
  /** triangle list over the render vertices */
  indices: Uint16Array;
  /** vertexCount × 2, v up */
  uvs: Float32Array;
  /** default texture url relative to the asset folder (null: untextured, e.g. cornea) */
  texture: string | null;
  /** alternative textures (eyes: iris colours) */
  textures: Record<string, string>;
  /** recommended material colour, LINEAR rgb, multiplied with the (grey / white) texture */
  tint: [number, number, number];
  render: ProxyRenderHints;
  /** hair only: baked ambient occlusion per render vertex (0 dark … 1 open), else null */
  ao: Uint8Array | null;
  /** hair only: strand direction in uv space per render vertex (int8, unit ≈ 127), else null */
  dir: Int8Array | null;
  // ── fitting data (views into proxies.bin) ──
  ref: Uint16Array; // fitCount × 3 base vertex indices
  wgt: Int16Array; // fitCount × 2: w1, w2 (w0 = 1 − w1 − w2), scale 1 / weightScale
  off: Int16Array; // fitCount × 3 offsets, scale 1 / offsetScale (dm)
  hw: Uint8Array; // fitCount: how much the vertex follows the head when posed (255 = head, 0 = torso)
  dup: Uint16Array; // (vertexCount − fitCount): canonical vertex of each duplicate
  scaleRef: Uint16Array; // 6: vertex pairs for x, y, z
  scaleDen: Float32Array; // 3
  shared: ProxyShared;
}

export interface FitOptions {
  /** Unposed (morphed) base vertices. Give it whenever `base` is posed: offsets then rotate with head / torso. */
  rest?: Float32Array;
  /** Output transform p·scale + offset (e.g. FitResult.scale / .offset → metres, feet on y = 0). Default 1 / none. */
  scale?: number;
  offset?: ArrayLike<number>;
}

/** Parses proxies.json + proxies.bin. Typed arrays are views into `buf` (keep it alive, do not transfer it). */
export function loadProxies(json: ProxiesJson, buf: ArrayBuffer): Proxy[] {
  const shared: ProxyShared = {
    baseVertexCount: json.baseVertexCount,
    weightScale: json.weightScale,
    offsetScale: json.offsetScale,
    headAnchor: Uint16Array.from(json.anchors.head),
    torsoAnchor: Uint16Array.from(json.anchors.torso),
    deleteVerts: Uint16Array.from(json.deleteVerts ?? []),
  };
  return json.proxies.map((p) => {
    const nDup = p.vertexCount - p.fitCount;
    const uvQ = new Uint16Array(buf, p.uv, p.vertexCount * 2);
    const uvs = new Float32Array(p.vertexCount * 2);
    for (let i = 0; i < uvs.length; i++) uvs[i] = uvQ[i] / 65535;
    const scaleRef = new Uint16Array(6);
    const scaleDen = new Float32Array(3);
    for (let n = 0; n < 3; n++) {
      scaleRef[n * 2] = p.scale[n][0];
      scaleRef[n * 2 + 1] = p.scale[n][1];
      scaleDen[n] = p.scale[n][2];
    }
    return {
      name: p.name,
      kind: p.kind,
      label: p.label,
      tags: p.tags ?? [],
      vertexCount: p.vertexCount,
      fitCount: p.fitCount,
      indices: new Uint16Array(buf, p.idx, p.triCount * 3),
      uvs,
      texture: p.texture,
      textures: p.textures ?? {},
      tint: [p.tint[0], p.tint[1], p.tint[2]],
      render: p.render,
      ao: p.ao !== undefined ? new Uint8Array(buf, p.ao, p.vertexCount) : null,
      dir: p.dir !== undefined ? new Int8Array(buf, p.dir, p.vertexCount * 2) : null,
      ref: new Uint16Array(buf, p.ref, p.fitCount * 3),
      wgt: new Int16Array(buf, p.wgt, p.fitCount * 2),
      off: new Int16Array(buf, p.off, p.fitCount * 3),
      hw: new Uint8Array(buf, p.hw, p.fitCount),
      dup: new Uint16Array(buf, p.dup, nDup),
      scaleRef,
      scaleDen,
      shared,
    };
  });
}

export async function loadProxyData(baseUrl: string): Promise<Proxy[]> {
  const [metaRes, binRes] = await Promise.all([fetch(baseUrl + 'proxies.json'), fetch(baseUrl + 'proxies.bin')]);
  if (!metaRes.ok || !binRes.ok) throw new Error('proxy asset not found');
  return loadProxies((await metaRes.json()) as ProxiesJson, await binRes.arrayBuffer());
}

// ───────────────────────── rigid frames (rest → posed) ─────────────────────────

const M = new Float64Array(9); // scratch 3×3 (row-major)
const N = new Float64Array(9);
const QH = new Float64Array(4);
const QT = new Float64Array(4);

/**
 * Rotation (unit quaternion x, y, z, w) that best maps the anchor vertices of `rest` onto `posed` in the least squares
 * sense (Kabsch). The orthogonal factor of the covariance is found with a scaled Newton polar iteration – no SVD.
 * Returns false (and the identity) if the fit is degenerate.
 */
export function anchorRotation(anchor: Uint16Array, rest: Float32Array, posed: Float32Array, q: Float64Array): boolean {
  const n = anchor.length;
  let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
  for (let i = 0; i < n; i++) {
    const j = anchor[i] * 3;
    ax += rest[j];
    ay += rest[j + 1];
    az += rest[j + 2];
    bx += posed[j];
    by += posed[j + 1];
    bz += posed[j + 2];
  }
  ax /= n; ay /= n; az /= n; bx /= n; by /= n; bz /= n;
  M.fill(0);
  let same = true;
  for (let i = 0; i < n; i++) {
    const j = anchor[i] * 3;
    const px = rest[j] - ax, py = rest[j + 1] - ay, pz = rest[j + 2] - az;
    const qx = posed[j] - bx, qy = posed[j + 1] - by, qz = posed[j + 2] - bz;
    if (same && (Math.abs(px - qx) > 1e-6 || Math.abs(py - qy) > 1e-6 || Math.abs(pz - qz) > 1e-6)) same = false;
    // S = Σ posed · restᵀ
    M[0] += qx * px; M[1] += qx * py; M[2] += qx * pz;
    M[3] += qy * px; M[4] += qy * py; M[5] += qy * pz;
    M[6] += qz * px; M[7] += qz * py; M[8] += qz * pz;
  }
  q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
  if (same) return true; // pure translation → identity
  for (let it = 0; it < 24; it++) {
    const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    if (!(det > 1e-12)) return false;
    // inverse transpose = cofactor matrix / det
    N[0] = (M[4] * M[8] - M[5] * M[7]) / det;
    N[1] = (M[5] * M[6] - M[3] * M[8]) / det;
    N[2] = (M[3] * M[7] - M[4] * M[6]) / det;
    N[3] = (M[2] * M[7] - M[1] * M[8]) / det;
    N[4] = (M[0] * M[8] - M[2] * M[6]) / det;
    N[5] = (M[1] * M[6] - M[0] * M[7]) / det;
    N[6] = (M[1] * M[5] - M[2] * M[4]) / det;
    N[7] = (M[2] * M[3] - M[0] * M[5]) / det;
    N[8] = (M[0] * M[4] - M[1] * M[3]) / det;
    const g = Math.cbrt(1 / det); // det-scaling: quadratic convergence from the first step
    let diff = 0;
    for (let k = 0; k < 9; k++) {
      const v = 0.5 * (g * M[k] + N[k] / g);
      diff += Math.abs(v - M[k]);
      M[k] = v;
    }
    if (diff < 1e-10) break;
  }
  // rotation matrix → quaternion
  const tr = M[0] + M[4] + M[8];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[3] = 0.25 * s; q[0] = (M[7] - M[5]) / s; q[1] = (M[2] - M[6]) / s; q[2] = (M[3] - M[1]) / s;
  } else if (M[0] > M[4] && M[0] > M[8]) {
    const s = Math.sqrt(1 + M[0] - M[4] - M[8]) * 2;
    q[3] = (M[7] - M[5]) / s; q[0] = 0.25 * s; q[1] = (M[1] + M[3]) / s; q[2] = (M[2] + M[6]) / s;
  } else if (M[4] > M[8]) {
    const s = Math.sqrt(1 + M[4] - M[0] - M[8]) * 2;
    q[3] = (M[2] - M[6]) / s; q[0] = (M[1] + M[3]) / s; q[1] = 0.25 * s; q[2] = (M[5] + M[7]) / s;
  } else {
    const s = Math.sqrt(1 + M[8] - M[0] - M[4]) * 2;
    q[3] = (M[3] - M[1]) / s; q[0] = (M[2] + M[6]) / s; q[1] = (M[5] + M[7]) / s; q[2] = 0.25 * s;
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
  return true;
}

// ───────────────────────── fitting ─────────────────────────

/**
 * Fits a proxy to the base mesh. `base`: all 19158 base vertices (decimetres), morphed and optionally posed.
 * Writes vertexCount × 3 floats into `out` (allocated if omitted) and returns it.
 * Pass `opts.rest` (the unposed morphed vertices) when `base` is posed.
 */
export function fitProxy(proxy: Proxy, base: Float32Array, out?: Float32Array, opts?: FitOptions): Float32Array {
  const { ref, wgt, off, hw, dup, scaleRef, scaleDen, fitCount, vertexCount, shared } = proxy;
  const pos = out ?? new Float32Array(vertexCount * 3);
  const rest = opts?.rest;
  const src = rest ?? base;
  // M: head extents (rest pose) / extents of the authoring human
  const ks = 1 / shared.offsetScale;
  const mx = (Math.abs(src[scaleRef[0] * 3] - src[scaleRef[1] * 3]) / scaleDen[0]) * ks;
  const my = (Math.abs(src[scaleRef[2] * 3 + 1] - src[scaleRef[3] * 3 + 1]) / scaleDen[1]) * ks;
  const mz = (Math.abs(src[scaleRef[4] * 3 + 2] - src[scaleRef[5] * 3 + 2]) / scaleDen[2]) * ks;
  const kw = 1 / shared.weightScale;
  const s = opts?.scale ?? 1;
  const o = opts?.offset;
  const tx = o ? o[0] : 0, ty = o ? o[1] : 0, tz = o ? o[2] : 0;

  let rotate = false;
  if (rest && rest !== base) {
    const okH = anchorRotation(shared.headAnchor, rest, base, QH);
    const okT = anchorRotation(shared.torsoAnchor, rest, base, QT);
    if (!okT) { QT[0] = QH[0]; QT[1] = QH[1]; QT[2] = QH[2]; QT[3] = QH[3]; }
    if (!okH) { QH[0] = QT[0]; QH[1] = QT[1]; QH[2] = QT[2]; QH[3] = QT[3]; }
    if (QH[0] * QT[0] + QH[1] * QT[1] + QH[2] * QT[2] + QH[3] * QT[3] < 0) { QT[0] = -QT[0]; QT[1] = -QT[1]; QT[2] = -QT[2]; QT[3] = -QT[3]; }
    rotate = Math.abs(QH[3]) < 0.9999999 || Math.abs(QT[3]) < 0.9999999;
  }
  const hx = QH[0], hy = QH[1], hz = QH[2], hww = QH[3];
  const dx = QT[0] - hx, dy = QT[1] - hy, dz = QT[2] - hz, dw = QT[3] - hww;

  for (let i = 0, i2 = 0, i3 = 0; i < fitCount; i++, i2 += 2, i3 += 3) {
    const a = ref[i3] * 3, b = ref[i3 + 1] * 3, c = ref[i3 + 2] * 3;
    const w1 = wgt[i2] * kw, w2 = wgt[i2 + 1] * kw;
    const ax = base[a], ay = base[a + 1], az = base[a + 2];
    let ox = off[i3] * mx, oy = off[i3 + 1] * my, oz = off[i3 + 2] * mz;
    if (rotate && (ox !== 0 || oy !== 0 || oz !== 0)) {
      // q = nlerp(torso, head, headness); v' = v + w·t + q×t with t = 2·q×v
      let qx = hx, qy = hy, qz = hz, qw = hww;
      const h = hw[i];
      if (h !== 255) {
        const f = 1 - h / 255;
        qx += dx * f; qy += dy * f; qz += dz * f; qw += dw * f;
        const l = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        qx *= l; qy *= l; qz *= l; qw *= l;
      }
      const t0 = 2 * (qy * oz - qz * oy), t1 = 2 * (qz * ox - qx * oz), t2 = 2 * (qx * oy - qy * ox);
      ox += qw * t0 + (qy * t2 - qz * t1);
      oy += qw * t1 + (qz * t0 - qx * t2);
      oz += qw * t2 + (qx * t1 - qy * t0);
    }
    pos[i3] = (ax + w1 * (base[b] - ax) + w2 * (base[c] - ax) + ox) * s + tx;
    pos[i3 + 1] = (ay + w1 * (base[b + 1] - ay) + w2 * (base[c + 1] - ay) + oy) * s + ty;
    pos[i3 + 2] = (az + w1 * (base[b + 2] - az) + w2 * (base[c + 2] - az) + oz) * s + tz;
  }
  // uv-seam duplicates share the position of their canonical vertex
  for (let k = 0, j = fitCount * 3; k < dup.length; k++, j += 3) {
    const c = dup[k] * 3;
    pos[j] = pos[c];
    pos[j + 1] = pos[c + 1];
    pos[j + 2] = pos[c + 2];
  }
  return pos;
}

// ───────────────────────── normals / tangents ─────────────────────────

/**
 * Smooth vertex normals (area weighted) of a fitted proxy; uv-seam duplicates get the normal of their canonical
 * vertex so no shading seam appears. `pos` = output of fitProxy. Writes vertexCount × 3 floats.
 */
export function computeProxyNormals(proxy: Proxy, pos: Float32Array, out?: Float32Array): Float32Array {
  const { indices, dup, fitCount, vertexCount } = proxy;
  const nrm = out ?? new Float32Array(vertexCount * 3);
  nrm.fill(0, 0, vertexCount * 3);
  for (let i = 0; i < indices.length; i += 3) {
    let a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const pa = a * 3, pb = b * 3, pc = c * 3;
    const ux = pos[pb] - pos[pa], uy = pos[pb + 1] - pos[pa + 1], uz = pos[pb + 2] - pos[pa + 2];
    const vx = pos[pc] - pos[pa], vy = pos[pc + 1] - pos[pa + 1], vz = pos[pc + 2] - pos[pa + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (a >= fitCount) a = dup[a - fitCount];
    if (b >= fitCount) b = dup[b - fitCount];
    if (c >= fitCount) c = dup[c - fitCount];
    a *= 3; b *= 3; c *= 3;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0; i < fitCount * 3; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (l > 0) {
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    } else nrm[i + 1] = 1;
  }
  for (let k = 0, j = fitCount * 3; k < dup.length; k++, j += 3) {
    const c = dup[k] * 3;
    nrm[j] = nrm[c];
    nrm[j + 1] = nrm[c + 1];
    nrm[j + 2] = nrm[c + 2];
  }
  return nrm;
}

/**
 * Hair shading normals: the geometric card normal bent towards the direction "away from the centre of the skull"
 * (`bend` 0 = geometric, 1 = fully radial). Hair cards lit with their true normals look like plates; bent normals give
 * the soft, volume-like falloff used for card hair in games. `pos` and `base` must be in the same space as passed to
 * fitProxy WITHOUT opts.scale / opts.offset, or pass the same `scale` / `offset` here.
 */
export function computeHairNormals(proxy: Proxy, pos: Float32Array, base: Float32Array, out?: Float32Array, bend = 0.6, opts?: FitOptions): Float32Array {
  const nrm = computeProxyNormals(proxy, pos, out);
  const anchor = proxy.shared.headAnchor;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < anchor.length; i++) {
    const j = anchor[i] * 3;
    cx += base[j]; cy += base[j + 1]; cz += base[j + 2];
  }
  const s = opts?.scale ?? 1;
  const o = opts?.offset;
  cx = (cx / anchor.length) * s + (o ? o[0] : 0);
  cy = (cy / anchor.length) * s + (o ? o[1] : 0);
  cz = (cz / anchor.length) * s + (o ? o[2] : 0);
  const n = proxy.vertexCount * 3;
  for (let i = 0; i < n; i += 3) {
    let rx = pos[i] - cx, ry = pos[i + 1] - cy, rz = pos[i + 2] - cz;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    let gx = nrm[i], gy = nrm[i + 1], gz = nrm[i + 2];
    // cards are double sided: use the side that faces outwards
    if (gx * rx + gy * ry + gz * rz < 0) { gx = -gx; gy = -gy; gz = -gz; }
    gx += (rx - gx) * bend; gy += (ry - gy) * bend; gz += (rz - gz) * bend;
    const l = Math.hypot(gx, gy, gz) || 1;
    nrm[i] = gx / l; nrm[i + 1] = gy / l; nrm[i + 2] = gz / l;
  }
  return nrm;
}

/**
 * Strand tangents for anisotropic (Kajiya–Kay) hair highlights: the 3D direction of each vertex's strand, derived from
 * the strand direction in uv space baked by the builder (`proxy.dir`) and the uv → 3D Jacobian of the fitted mesh.
 * Returns null for proxies without baked directions. Writes vertexCount × 3 floats (unit vectors, sign arbitrary).
 */
export function computeProxyTangents(proxy: Proxy, pos: Float32Array, out?: Float32Array): Float32Array | null {
  const dir = proxy.dir;
  if (!dir) return null;
  const { indices, uvs, dup, fitCount, vertexCount } = proxy;
  const tan = out ?? new Float32Array(vertexCount * 3);
  tan.fill(0, 0, vertexCount * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const pa = a * 3, pb = b * 3, pc = c * 3;
    const e1x = pos[pb] - pos[pa], e1y = pos[pb + 1] - pos[pa + 1], e1z = pos[pb + 2] - pos[pa + 2];
    const e2x = pos[pc] - pos[pa], e2y = pos[pc + 1] - pos[pa + 1], e2z = pos[pc + 2] - pos[pa + 2];
    const du1 = uvs[b * 2] - uvs[a * 2], dv1 = uvs[b * 2 + 1] - uvs[a * 2 + 1];
    const du2 = uvs[c * 2] - uvs[a * 2], dv2 = uvs[c * 2 + 1] - uvs[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    // ∂P/∂u and ∂P/∂v
    const pux = (e1x * dv2 - e2x * dv1) * r, puy = (e1y * dv2 - e2y * dv1) * r, puz = (e1z * dv2 - e2z * dv1) * r;
    const pvx = (e2x * du1 - e1x * du2) * r, pvy = (e2y * du1 - e1y * du2) * r, pvz = (e2z * du1 - e1z * du2) * r;
    for (let k = 0; k < 3; k++) {
      const v = indices[i + k];
      const d0 = dir[v * 2], d1 = dir[v * 2 + 1];
      let tx = pux * d0 + pvx * d1, ty = puy * d0 + pvy * d1, tz = puz * d0 + pvz * d1;
      const l = Math.hypot(tx, ty, tz);
      if (l === 0) continue;
      tx /= l; ty /= l; tz /= l;
      const j = (v >= fitCount ? dup[v - fitCount] : v) * 3;
      // directions are axial (±): accumulate with a consistent sign
      if (tan[j] * tx + tan[j + 1] * ty + tan[j + 2] * tz < 0) { tx = -tx; ty = -ty; tz = -tz; }
      tan[j] += tx; tan[j + 1] += ty; tan[j + 2] += tz;
    }
  }
  for (let i = 0; i < fitCount * 3; i += 3) {
    const l = Math.hypot(tan[i], tan[i + 1], tan[i + 2]);
    if (l > 0) {
      tan[i] /= l; tan[i + 1] /= l; tan[i + 2] /= l;
    } else tan[i + 1] = -1;
  }
  for (let k = 0, j = fitCount * 3; k < dup.length; k++, j += 3) {
    const c = dup[k] * 3;
    tan[j] = tan[c];
    tan[j + 1] = tan[c + 1];
    tan[j + 2] = tan[c + 2];
  }
  return tan;
}

/** Proxies of one kind, in asset order (first = default). */
export function proxiesOfKind(all: Proxy[], kind: ProxyKind): Proxy[] {
  return all.filter((p) => p.kind === kind);
}
