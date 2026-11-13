/**
 * Surface Nets polygonizer with narrow-band evaluation + Newton projection onto the exact iso-surface.
 * The template topology is generated once; later compositions re-project the same vertices,
 * which gives smooth morphing with identical topology.
 */
import type { BodySpec, Part } from './model';
import { gradient, makeSdf, type Sdf } from './sdf';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export function polygonize(spec: BodySpec, cell = 0.007): MeshData {
  const f = makeSdf(spec);
  const [x0, y0, z0] = spec.min;
  const [x1, y1, z1] = spec.max;
  const C = 4; // coarse factor
  const nx = Math.ceil((x1 - x0) / cell / C) * C + 1;
  const ny = Math.ceil((y1 - y0) / cell / C) * C + 1;
  const nz = Math.ceil((z1 - z0) / cell / C) * C + 1;
  const cnx = (nx - 1) / C + 1;
  const cny = (ny - 1) / C + 1;
  const cnz = (nz - 1) / C + 1;
  const ch = cell * C;

  // 1) coarse samples
  const coarse = new Float32Array(cnx * cny * cnz);
  for (let k = 0; k < cnz; k++)
    for (let j = 0; j < cny; j++)
      for (let i = 0; i < cnx; i++) coarse[i + cnx * (j + cny * k)] = f(x0 + i * ch, y0 + j * ch, z0 + k * ch);

  // 2) mark coarse cells near the surface, then dilate
  const ccx = cnx - 1;
  const ccy = cny - 1;
  const ccz = cnz - 1;
  const mark = new Uint8Array(ccx * ccy * ccz);
  const diag = ch * Math.sqrt(3);
  for (let k = 0; k < ccz; k++)
    for (let j = 0; j < ccy; j++)
      for (let i = 0; i < ccx; i++) {
        let neg = 0;
        let mn = Infinity;
        for (let c = 0; c < 8; c++) {
          const v = coarse[i + (c & 1) + cnx * (j + ((c >> 1) & 1) + cny * (k + ((c >> 2) & 1)))];
          if (v < 0) neg++;
          const a = Math.abs(v);
          if (a < mn) mn = a;
        }
        if ((neg > 0 && neg < 8) || mn < diag * 0.9) mark[i + ccx * (j + ccy * k)] = 1;
      }
  const mark2 = new Uint8Array(mark.length);
  for (let k = 0; k < ccz; k++)
    for (let j = 0; j < ccy; j++)
      for (let i = 0; i < ccx; i++) {
        if (!mark[i + ccx * (j + ccy * k)]) continue;
        for (let dk = -1; dk <= 1; dk++)
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const a = i + di;
              const b = j + dj;
              const c = k + dk;
              if (a < 0 || b < 0 || c < 0 || a >= ccx || b >= ccy || c >= ccz) continue;
              mark2[a + ccx * (b + ccy * c)] = 1;
            }
      }

  // 3) fine samples inside marked coarse cells
  const NaNv = 1e9;
  const fine = new Float32Array(nx * ny * nz).fill(NaNv);
  for (let k = 0; k < ccz; k++)
    for (let j = 0; j < ccy; j++)
      for (let i = 0; i < ccx; i++) {
        if (!mark2[i + ccx * (j + ccy * k)]) continue;
        for (let fk = 0; fk <= C; fk++)
          for (let fj = 0; fj <= C; fj++)
            for (let fi = 0; fi <= C; fi++) {
              const gi = i * C + fi;
              const gj = j * C + fj;
              const gk = k * C + fk;
              const idx = gi + nx * (gj + ny * gk);
              if (fine[idx] !== NaNv) continue;
              fine[idx] = f(x0 + gi * cell, y0 + gj * cell, z0 + gk * cell);
            }
      }

  // 4) surface nets
  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const off = (c: number) => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
  const OFF = Array.from({ length: 8 }, (_, c) => off(c));
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let neg = 0;
        let bad = false;
        for (let c = 0; c < 8; c++) {
          const v = fine[i + (c & 1) + nx * (j + ((c >> 1) & 1) + ny * (k + ((c >> 2) & 1)))];
          if (v === NaNv) {
            bad = true;
            break;
          }
          corner[c] = v;
          if (v < 0) neg++;
        }
        if (bad || neg === 0 || neg === 8) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          cnt = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const oa = OFF[a];
          const ob = OFF[b];
          sx += oa[0] + (ob[0] - oa[0]) * t;
          sy += oa[1] + (ob[1] - oa[1]) * t;
          sz += oa[2] + (ob[2] - oa[2]) * t;
          cnt++;
        }
        cellVert[i + cx * (j + cy * k)] = pos.length / 3;
        pos.push(x0 + (i + sx / cnt) * cell, y0 + (j + sy / cnt) * cell, z0 + (k + sz / cnt) * cell);
      }

  // faces: for each grid edge with a sign change, connect the 4 cells around it
  const idx: number[] = [];
  const cv = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz ? -1 : cellVert[i + cx * (j + cy * k)]);
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = fine[i + nx * (j + ny * k)];
        if (v0 === NaNv) continue;
        const in0 = v0 < 0;
        // +x edge
        if (i < nx - 1) {
          const v1 = fine[i + 1 + nx * (j + ny * k)];
          if (v1 !== NaNv && in0 !== v1 < 0) quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), !in0);
        }
        // +y edge
        if (j < ny - 1) {
          const v1 = fine[i + nx * (j + 1 + ny * k)];
          if (v1 !== NaNv && in0 !== v1 < 0) quad(cv(i - 1, j, k - 1), cv(i - 1, j, k), cv(i, j, k), cv(i, j, k - 1), !in0);
        }
        // +z edge
        if (k < nz - 1) {
          const v1 = fine[i + nx * (j + ny * (k + 1))];
          if (v1 !== NaNv && in0 !== v1 < 0) quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), !in0);
        }
      }

  const positions = new Float32Array(pos);
  const normals = new Float32Array(positions.length);
  project(f, positions, normals, 3);
  return { positions, normals, indices: new Uint32Array(idx) };
}

/** Newton-project points onto the zero set of f and write normalized gradients into `normals`. */
export function project(f: Sdf, positions: Float32Array, normals: Float32Array, iterations = 3) {
  const n = positions.length / 3;
  for (let v = 0; v < n; v++) {
    let x = positions[v * 3];
    let y = positions[v * 3 + 1];
    let z = positions[v * 3 + 2];
    let g: [number, number, number] = [0, 1, 0];
    for (let it = 0; it < iterations; it++) {
      const d = f(x, y, z);
      g = gradient(f, x, y, z);
      const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (g2 < 1e-10) break;
      // damp large steps for stability
      let s = d / g2;
      const step = Math.abs(d) / Math.sqrt(g2);
      if (step > 0.05) s *= 0.05 / step;
      x -= g[0] * s;
      y -= g[1] * s;
      z -= g[2] * s;
      if (Math.abs(d) < 1e-5) break;
    }
    g = gradient(f, x, y, z);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = g[0] / gl;
    normals[v * 3 + 1] = g[1] / gl;
    normals[v * 3 + 2] = g[2] / gl;
  }
}

/**
 * Morph: re-project template vertices onto a different body.
 * Uses a secant search along the template normal (1 SDF eval / iteration) and a final gradient for shading.
 */
export interface ArmSkin {
  w: Float32Array; // rotation weight 0..1
  side: Int8Array; // -1 left, 1 right, 0 none
  angleDeg: number; // template arm angle
  pivot: [number, number, number]; // right shoulder pivot
}

/** Classify template vertices that belong to the arms, with a smooth weight from the shoulder. */
export function computeArmSkin(spec: BodySpec, positions: Float32Array): ArmSkin {
  const armParts: Part[] = ['arm', 'forearm', 'hand'];
  const otherParts: Part[] = ['torso', 'neck', 'head', 'thigh', 'calf', 'foot'];
  const fR = makeSdf(spec, { parts: armParts, side: 1, noTorso: true });
  const fL = makeSdf(spec, { parts: armParts, side: -1, noTorso: true });
  const fO = makeSdf(spec, { parts: otherParts });
  const n = positions.length / 3;
  const w = new Float32Array(n);
  const side = new Int8Array(n);
  const [px, py, pz] = spec.info.shoulder;
  const ang = (spec.info.armAngleDeg * Math.PI) / 180;
  const dir = [Math.sin(ang), -Math.cos(ang), 0];
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    if (y < py - 0.9 || y > py + 0.12) continue;
    const s = x >= 0 ? 1 : -1;
    const dA = s > 0 ? fR(x, y, z) : fL(x, y, z);
    const dO = fO(x, y, z);
    if (dA > dO + 0.004) continue;
    const t = (x * s - px) * dir[0] + (y - py) * dir[1] + (z - pz) * dir[2];
    const ww = Math.min(1, Math.max(0, (t + 0.01) / 0.09));
    w[v] = ww * ww * (3 - 2 * ww);
    side[v] = s;
  }
  return { w, side, angleDeg: spec.info.armAngleDeg, pivot: [px, py, pz] };
}

function applyArmSkin(src: Float32Array, srcN: Float32Array, skin: ArmSkin, newAngleDeg: number) {
  const pos = new Float32Array(src);
  const nor = new Float32Array(srcN);
  const d = ((newAngleDeg - skin.angleDeg) * Math.PI) / 180;
  if (Math.abs(d) < 1e-4) return { pos, nor };
  const [px, py] = skin.pivot;
  const n = src.length / 3;
  for (let v = 0; v < n; v++) {
    const s = skin.side[v];
    if (!s || skin.w[v] <= 0) continue;
    const a = d * skin.w[v] * s;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const pivX = px * s;
    const x = pos[v * 3] - pivX;
    const y = pos[v * 3 + 1] - py;
    pos[v * 3] = pivX + x * c - y * sn;
    pos[v * 3 + 1] = py + x * sn + y * c;
    const nx = nor[v * 3];
    const ny = nor[v * 3 + 1];
    nor[v * 3] = nx * c - ny * sn;
    nor[v * 3 + 1] = nx * sn + ny * c;
  }
  return { pos, nor };
}

export function morph(
  templateIn: Float32Array,
  templateNormalsIn: Float32Array,
  spec: BodySpec,
  skin?: ArmSkin,
): { positions: Float32Array; normals: Float32Array } {
  const f = makeSdf(spec);
  let template = templateIn;
  let templateNormals = templateNormalsIn;
  if (skin) {
    const r = applyArmSkin(templateIn, templateNormalsIn, skin, spec.info.armAngleDeg);
    template = r.pos;
    templateNormals = r.nor;
  }
  const n = template.length / 3;
  const positions = new Float32Array(template.length);
  const normals = new Float32Array(template.length);
  for (let v = 0; v < n; v++) {
    const px = template[v * 3];
    const py = template[v * 3 + 1];
    const pz = template[v * 3 + 2];
    const nx = templateNormals[v * 3];
    const ny = templateNormals[v * 3 + 1];
    const nz = templateNormals[v * 3 + 2];
    let t0 = 0;
    let d0 = f(px, py, pz);
    let x = px,
      y = py,
      z = pz;
    if (Math.abs(d0) > 2e-5) {
      let t1 = -d0;
      let d1 = f(px + nx * t1, py + ny * t1, pz + nz * t1);
      for (let it = 0; it < 6 && Math.abs(d1) > 2e-5; it++) {
        const den = d1 - d0;
        if (Math.abs(den) < 1e-9) break;
        let t2 = t1 - (d1 * (t1 - t0)) / den;
        if (!Number.isFinite(t2) || Math.abs(t2) > 0.25) t2 = t1 - d1;
        t0 = t1;
        d0 = d1;
        t1 = t2;
        d1 = f(px + nx * t1, py + ny * t1, pz + nz * t1);
      }
      x = px + nx * t1;
      y = py + ny * t1;
      z = pz + nz * t1;
      // fallback: gradient Newton if the line search did not converge
      if (Math.abs(d1) > 0.002) {
        for (let it = 0; it < 4; it++) {
          const d = f(x, y, z);
          const g = gradient(f, x, y, z);
          const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
          if (g2 < 1e-10 || Math.abs(d) < 2e-5) break;
          x -= (g[0] * d) / g2;
          y -= (g[1] * d) / g2;
          z -= (g[2] * d) / g2;
        }
      }
    }
    const g = gradient(f, x, y, z);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = g[0] / gl;
    normals[v * 3 + 1] = g[1] / gl;
    normals[v * 3 + 2] = g[2] / gl;
  }
  return { positions, normals };
}
