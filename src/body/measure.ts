/**
 * "Virtual tape measure": circumferences of the model computed like a real tape –
 * the convex hull perimeter of the body cross-section.
 */
import type { BodySpec, Part, Vec3 } from './model';
import { makeSdf, type Sdf } from './sdf';

export interface Girth {
  key: 'neck' | 'chest' | 'waist' | 'hips' | 'arm' | 'forearm' | 'thigh' | 'calf';
  label: string;
  cm: number;
  /** ring points for drawing (world space, closed loop) */
  ring: number[];
}

const RAYS = 72;

function sectionRing(f: Sdf, c: Vec3, u: Vec3, v: Vec3, rMax: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < RAYS; i++) {
    const th = (i / RAYS) * Math.PI * 2;
    const dx = u[0] * Math.cos(th) + v[0] * Math.sin(th);
    const dy = u[1] * Math.cos(th) + v[1] * Math.sin(th);
    const dz = u[2] * Math.cos(th) + v[2] * Math.sin(th);
    // march outward until outside
    let lo = 0;
    let hi = 0;
    const step = 0.004;
    let r = 0;
    let found = false;
    while (r < rMax) {
      r += step;
      if (f(c[0] + dx * r, c[1] + dy * r, c[2] + dz * r) > 0) {
        hi = r;
        lo = r - step;
        found = true;
        break;
      }
    }
    if (!found) continue;
    for (let k = 0; k < 18; k++) {
      const m = (lo + hi) / 2;
      if (f(c[0] + dx * m, c[1] + dy * m, c[2] + dz * m) > 0) hi = m;
      else lo = m;
    }
    const rr = (lo + hi) / 2;
    pts.push([c[0] + dx * rr, c[1] + dy * rr, c[2] + dz * rr]);
  }
  return pts;
}

/** 2D convex hull perimeter of points projected on basis (u, v). */
function hullPerimeter(pts: Vec3[], c: Vec3, u: Vec3, v: Vec3): { perim: number; hull: Vec3[] } {
  const p2 = pts.map((p) => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return { x: d[0] * u[0] + d[1] * u[1] + d[2] * u[2], y: d[0] * v[0] + d[1] * v[1] + d[2] * v[2], p };
  });
  p2.sort((a, b) => a.x - b.x || a.y - b.y);
  const crossZ = (o: (typeof p2)[0], a: (typeof p2)[0], b: (typeof p2)[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof p2 = [];
  for (const p of p2) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: typeof p2 = [];
  for (let i = p2.length - 1; i >= 0; i--) {
    const p = p2[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let perim = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    perim += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return { perim, hull: hull.map((h) => h.p) };
}

function perpBasis(axis: Vec3): [Vec3, Vec3] {
  const a = axis;
  const ref: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u: Vec3 = [a[1] * ref[2] - a[2] * ref[1], a[2] * ref[0] - a[0] * ref[2], a[0] * ref[1] - a[1] * ref[0]];
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: Vec3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return [u, v];
}

function girthAt(f: Sdf, c: Vec3, axis: Vec3, rMax: number) {
  const [u, v] = perpBasis(axis);
  const pts = sectionRing(f, c, u, v, rMax);
  if (pts.length < 8) return { cm: 0, ring: [] as number[] };
  const { perim, hull } = hullPerimeter(pts, c, u, v);
  return { cm: perim * 100, ring: hull.flat() };
}

export function measureBody(spec: BodySpec): Girth[] {
  const torsoF = makeSdf(spec, { parts: ['torso'] as Part[] });
  const hipsF = makeSdf(spec, { parts: ['torso', 'thigh'] as Part[] });
  const neckF = makeSdf(spec, { parts: ['neck'], noTorso: true });
  const up: Vec3 = [0, 1, 0];
  const lv = spec.info.levels;
  const out: Girth[] = [];
  const isM = spec.input.sex === 'male';

  out.push({ key: 'neck', label: 'Шея', ...girthAt(neckF, [0, lv.neck, -0.004], up, 0.2) });
  // chest: max around chest level
  let best = { cm: 0, ring: [] as number[] };
  for (let d = -0.02; d <= 0.021; d += 0.01) {
    const g = girthAt(torsoF, [0, lv.chest + d, 0], up, 0.4);
    if (g.cm > best.cm) best = g;
  }
  out.push({ key: 'chest', label: isM ? 'Грудь' : 'Грудь (обхват)', ...best });
  // waist: men – at navel, women – narrowest point
  if (isM) out.push({ key: 'waist', label: 'Талия (пупок)', ...girthAt(torsoF, [0, lv.navel, 0], up, 0.45) });
  else {
    let w = { cm: 1e9, ring: [] as number[] };
    for (let d = -0.03; d <= 0.031; d += 0.01) {
      const g = girthAt(torsoF, [0, lv.waist + d, 0], up, 0.45);
      if (g.cm > 0 && g.cm < w.cm) w = g;
    }
    out.push({ key: 'waist', label: 'Талия', ...w });
  }
  // hips: max around buttocks
  let h = { cm: 0, ring: [] as number[] };
  for (let d = -0.03; d <= 0.031; d += 0.01) {
    const g = girthAt(hipsF, [0, lv.hips + d, -0.01], up, 0.45);
    if (g.cm > h.cm) h = g;
  }
  out.push({ key: 'hips', label: 'Бёдра (ягодицы)', ...h });

  for (const fr of spec.limbFrames) {
    const f = makeSdf(spec, { parts: fr.part, side: 1, noTorso: true });
    const g = girthAt(f, fr.c, fr.axis, 0.2);
    const label = fr.name === 'arm' ? 'Бицепс' : fr.name === 'forearm' ? 'Предплечье' : fr.name === 'thigh' ? 'Бедро' : 'Голень';
    out.push({ key: fr.name, label, ...g });
  }
  return out;
}
