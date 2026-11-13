/**
 * Fast signed-distance evaluation for a BodySpec.
 * Distances are approximate (bounds) but the zero level set is exact for the lofted torso
 * and round cones; ellipsoids use Quilez' approximation.
 */
import { monotoneSlopes, type BodySpec, type Part } from './model';

export type Sdf = (x: number, y: number, z: number) => number;

function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

interface CompiledPrim {
  type: 0 | 1; // 0 ellipsoid, 1 round cone
  k: number;
  bx: number;
  by: number;
  bz: number;
  br: number;
  // ellipsoid
  cx: number;
  cy: number;
  cz: number;
  R: number[];
  rx: number;
  ry: number;
  rz: number;
  // cone
  ax: number;
  ay: number;
  az: number;
  bax: number;
  bay: number;
  baz: number;
  l2: number;
  rr: number;
  a2: number;
  il2: number;
  r1: number;
  r2: number;
}

function compilePrims(spec: BodySpec, parts?: Part[], side?: number): CompiledPrim[] {
  const out: CompiledPrim[] = [];
  for (const p of spec.prims) {
    if (parts && !parts.includes(p.part)) continue;
    if (side !== undefined && p.side !== 0 && p.side !== side) continue;
    const base: CompiledPrim = {
      type: 0, k: p.k, bx: 0, by: 0, bz: 0, br: 0,
      cx: 0, cy: 0, cz: 0, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], rx: 1, ry: 1, rz: 1,
      ax: 0, ay: 0, az: 0, bax: 0, bay: 0, baz: 0, l2: 1, rr: 0, a2: 1, il2: 1, r1: 0, r2: 0,
    };
    if (p.kind === 'e') {
      base.type = 0;
      base.cx = p.c[0];
      base.cy = p.c[1];
      base.cz = p.c[2];
      base.R = p.R;
      base.rx = p.r[0];
      base.ry = p.r[1];
      base.rz = p.r[2];
      base.bx = p.c[0];
      base.by = p.c[1];
      base.bz = p.c[2];
      base.br = Math.max(p.r[0], p.r[1], p.r[2]);
    } else {
      base.type = 1;
      base.ax = p.a[0];
      base.ay = p.a[1];
      base.az = p.a[2];
      base.bax = p.b[0] - p.a[0];
      base.bay = p.b[1] - p.a[1];
      base.baz = p.b[2] - p.a[2];
      base.l2 = base.bax * base.bax + base.bay * base.bay + base.baz * base.baz;
      base.rr = p.r1 - p.r2;
      base.a2 = base.l2 - base.rr * base.rr;
      base.il2 = 1 / base.l2;
      base.r1 = p.r1;
      base.r2 = p.r2;
      base.bx = (p.a[0] + p.b[0]) / 2;
      base.by = (p.a[1] + p.b[1]) / 2;
      base.bz = (p.a[2] + p.b[2]) / 2;
      base.br = Math.sqrt(base.l2) / 2 + Math.max(p.r1, p.r2);
    }
    out.push(base);
  }
  return out;
}

function evalEllipsoid(p: CompiledPrim, x: number, y: number, z: number) {
  const dx = x - p.cx;
  const dy = y - p.cy;
  const dz = z - p.cz;
  const R = p.R;
  // local = R^T · d  (columns of R are local axes)
  const lx = (R[0] * dx + R[3] * dy + R[6] * dz) / p.rx;
  const ly = (R[1] * dx + R[4] * dy + R[7] * dz) / p.ry;
  const lz = (R[2] * dx + R[5] * dy + R[8] * dz) / p.rz;
  const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const k1 = Math.sqrt((lx / p.rx) ** 2 + (ly / p.ry) ** 2 + (lz / p.rz) ** 2);
  if (k1 < 1e-9) return -Math.min(p.rx, p.ry, p.rz);
  return (k0 * (k0 - 1)) / k1;
}

function evalCone(p: CompiledPrim, x: number, y: number, z: number) {
  const pax = x - p.ax;
  const pay = y - p.ay;
  const paz = z - p.az;
  const l2 = p.l2;
  const yy = pax * p.bax + pay * p.bay + paz * p.baz;
  const zz = yy - l2;
  const xvx = pax * l2 - p.bax * yy;
  const xvy = pay * l2 - p.bay * yy;
  const xvz = paz * l2 - p.baz * yy;
  const x2 = xvx * xvx + xvy * xvy + xvz * xvz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const rr = p.rr;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * p.a2 * z2 > k) return Math.sqrt(x2 + z2) * p.il2 - p.r2;
  if (Math.sign(yy) * p.a2 * y2 < k) return Math.sqrt(x2 + y2) * p.il2 - p.r1;
  return (Math.sqrt(x2 * p.a2 * p.il2) + yy * rr) * p.il2 - p.r1;
}

function makeTorso(spec: BodySpec) {
  const st = spec.torso;
  const ys = st.map((s) => s.y);
  const A = st.map((s) => s.a);
  const F = st.map((s) => s.f);
  const B = st.map((s) => s.b);
  const N = st.map((s) => s.n);
  const mA = monotoneSlopes(ys, A);
  const mF = monotoneSlopes(ys, F);
  const mB = monotoneSlopes(ys, B);
  const mN = monotoneSlopes(ys, N);
  const y0 = ys[0];
  const y1 = ys[ys.length - 1];
  const n = ys.length;

  const herm = (i: number, t: number, h: number, v: number[], m: number[]) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * v[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * v[i + 1] + (t3 - t2) * h * m[i + 1];
  };

  const out = { a: 0, f: 0, b: 0, n: 2 };
  const params = (y: number) => {
    const yc = y < y0 ? y0 : y > y1 ? y1 : y;
    let i = 0;
    while (i < n - 2 && yc > ys[i + 1]) i++;
    const h = ys[i + 1] - ys[i];
    const t = (yc - ys[i]) / h;
    out.a = herm(i, t, h, A, mA);
    out.f = herm(i, t, h, F, mF);
    out.b = herm(i, t, h, B, mB);
    out.n = herm(i, t, h, N, mN);
    return out;
  };

  const sdf = (x: number, y: number, z: number) => {
    const p = params(y);
    const ax = Math.abs(x);
    const rz = z > 0 ? p.f : p.b;
    const az = Math.abs(z);
    const u = ax / p.a;
    const v = az / rz;
    let d2: number;
    if (u + v < 1e-7) d2 = -Math.min(p.a, rz);
    else {
      const nn = p.n;
      const un = Math.pow(u, nn);
      const vn = Math.pow(v, nn);
      const F_ = Math.pow(un + vn, 1 / nn);
      const k = Math.pow(F_, 1 - nn);
      const gx = (k * Math.pow(u, nn - 1)) / p.a;
      const gz = (k * Math.pow(v, nn - 1)) / rz;
      const g = Math.sqrt(gx * gx + gz * gz) || 1e-6;
      d2 = (F_ - 1) / g;
    }
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    if (dy > 0) return d2 > 0 ? Math.sqrt(d2 * d2 + dy * dy) : Math.max(d2, dy);
    return d2;
  };
  return { sdf, params };
}

export function makeSdf(spec: BodySpec, opts?: { parts?: Part[]; side?: number; noTorso?: boolean }): Sdf {
  const torso = makeTorso(spec);
  const prims = compilePrims(spec, opts?.parts, opts?.side);
  const useTorso = !opts?.noTorso && (!opts?.parts || opts.parts.includes('torso'));
  const np = prims.length;
  return (x: number, y: number, z: number) => {
    let d = useTorso ? torso.sdf(x, y, z) : 1e9;
    for (let i = 0; i < np; i++) {
      const p = prims[i];
      const bx = x - p.bx;
      const by = y - p.by;
      const bz = z - p.bz;
      const bd = Math.sqrt(bx * bx + by * by + bz * bz) - p.br;
      if (bd - d >= p.k) continue;
      const di = p.type === 0 ? evalEllipsoid(p, x, y, z) : evalCone(p, x, y, z);
      d = d > 1e8 ? di : smin(d, di, p.k);
    }
    return d;
  };
}

export function torsoParams(spec: BodySpec) {
  return makeTorso(spec).params;
}

/** Tetrahedral gradient (4 evaluations). Returns unnormalized gradient and the value at p (approx). */
export function gradient(f: Sdf, x: number, y: number, z: number, h = 0.0008): [number, number, number] {
  const a = f(x + h, y - h, z - h);
  const b = f(x - h, y - h, z + h);
  const c = f(x - h, y + h, z - h);
  const d = f(x + h, y + h, z + h);
  return [(a - b - c + d) / (4 * h), (-a - b + c + d) / (4 * h), (-a + b - c + d) / (4 * h)];
}
