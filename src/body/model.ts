/**
 * Parametric anthropometric body model.
 *
 * Body composition (height, fat mass, fat-free mass, skeletal muscle) → geometric description
 * of the body as a signed distance field made of a lofted torso + ellipsoids + round cones.
 *
 * Realism principles:
 *  - Skeleton (segment lengths, joint positions) depends only on height & sex.
 *  - Lean tissue sets the "core" cross-sections: cross-sectional AREA scales with segment lean mass / length.
 *  - Fat is distributed as physical VOLUME (ρ adipose ≈ 0.9 kg/L) into sex-specific depots
 *    (android pattern for men, gynoid for women) + visceral fat that pushes the abdominal wall forward.
 *  - Fat volume is converted into layer thickness over the underlying surface, so 1 kg of fat
 *    spread over the whole body changes the waist by roughly ~1 cm, while 10 kg is clearly visible.
 *  - Muscle definition (abs, separations) appears only when the covering fat layer becomes thin.
 */
import type { Sex } from '../lib/types';

export interface BodyInput {
  sex: Sex;
  heightCm: number;
  weight: number;
  fatKg: number;
  ffm: number;
  smm?: number;
}

export type Vec3 = [number, number, number];
export type Part = 'torso' | 'neck' | 'head' | 'arm' | 'forearm' | 'hand' | 'thigh' | 'calf' | 'foot';

export interface EllipsoidPrim {
  kind: 'e';
  c: Vec3;
  r: Vec3;
  /** Columns = local axes expressed in world space (x, y, z). Row-major 3×3. */
  R: number[];
  k: number;
  part: Part;
  side: -1 | 0 | 1;
  tag?: string;
}

export interface ConePrim {
  kind: 'c';
  a: Vec3;
  b: Vec3;
  r1: number;
  r2: number;
  k: number;
  part: Part;
  side: -1 | 0 | 1;
  tag?: string;
}

export type Prim = EllipsoidPrim | ConePrim;

export interface TorsoStation {
  y: number; // m
  a: number; // half width, m
  f: number; // front depth from axis, m
  b: number; // back depth from axis, m
  n: number; // superellipse exponent
}

export interface BodyInfo {
  heightM: number;
  sat: number; // subcutaneous fat, kg
  vat: number; // visceral fat, kg
  essential: number;
  /** 0..1 how visible the abs are */
  absVis: number;
  /** 0..1 general muscle definition (separations) */
  definition: number;
  /** front abdominal subcutaneous fat thickness, mm */
  absFatMm: number;
  armFatMm: number;
  thighFatMm: number;
  armAngleDeg: number;
  /** right shoulder pivot (m) */
  shoulder: Vec3;
  muscleScale: number;
  levels: { navel: number; waist: number; chest: number; hips: number; neck: number };
}

export interface BodySpec {
  input: BodyInput;
  torso: TorsoStation[];
  prims: Prim[];
  info: BodyInfo;
  /** Axis-aligned bounds (with margin) */
  min: Vec3;
  max: Vec3;
  /** Limb measurement frames: center & axis for circumference measurement */
  limbFrames: { name: 'arm' | 'thigh' | 'calf' | 'forearm'; c: Vec3; axis: Vec3; part: Part[]; side: 1 }[];
}

// ───────────────────────── Reference people ─────────────────────────

interface SexRef {
  H: number; // cm
  weight: number;
  fat: number;
  ffm: number;
  smm: number;
  /** [yFrac, a, f, b, n] – TOTAL shape (lean + reference fat), cm at reference height */
  torso: [number, number, number, number, number][];
  depots: Depot[];
  limbFat: { thigh: number; calf: number; upperArm: number; forearm: number; neckFace: number; glutes: number; breasts: number };
  nonVisiblePerFfm: number;
  vat: (fm: number) => number;
}

interface Depot {
  w: number; // share of SAT
  yc: number; // fraction of H
  sigma: number; // fraction of H
  /** split of area increase between front, back and sides */
  f: number;
  b: number;
  a: number;
}

const MALE: SexRef = {
  H: 178,
  weight: 78,
  fat: 14,
  ffm: 64,
  smm: 36,
  torso: [
    [0.452, 9.5, 6.0, 6.5, 2.0],
    [0.478, 14.6, 8.0, 8.6, 2.0],
    [0.505, 16.2, 8.6, 9.0, 2.0],
    [0.532, 16.6, 9.4, 9.0, 2.1],
    [0.56, 16.0, 10.9, 8.8, 2.1],
    [0.585, 16.2, 11.6, 9.3, 2.0],
    [0.605, 16.3, 11.95, 9.8, 2.0],
    [0.625, 16.1, 11.8, 10.3, 2.0],
    [0.66, 15.9, 11.2, 11.0, 2.1],
    [0.695, 16.7, 10.8, 11.8, 2.2],
    [0.725, 17.3, 10.0, 12.2, 2.3],
    [0.755, 17.5, 9.6, 12.2, 2.4],
    [0.783, 16.8, 8.8, 11.2, 2.5],
    [0.803, 15.4, 7.6, 9.6, 2.4],
    [0.822, 10.0, 6.4, 7.6, 2.2],
    [0.84, 6.6, 5.6, 6.0, 2.0],
  ],
  depots: [
    { w: 0.1, yc: 0.6, sigma: 0.065, f: 0.65, b: 0, a: 0.35 }, // belly
    { w: 0.07, yc: 0.6, sigma: 0.045, f: 0, b: 0.15, a: 0.85 }, // flanks / love handles
    { w: 0.08, yc: 0.72, sigma: 0.035, f: 0.6, b: 0, a: 0.4 }, // chest
    { w: 0.12, yc: 0.71, sigma: 0.06, f: 0, b: 0.7, a: 0.3 }, // upper back
    { w: 0.04, yc: 0.61, sigma: 0.045, f: 0, b: 1, a: 0 }, // lower back
    { w: 0.05, yc: 0.53, sigma: 0.03, f: 0, b: 0.5, a: 0.5 }, // hips
  ],
  limbFat: { thigh: 0.26, calf: 0.07, upperArm: 0.08, forearm: 0.03, neckFace: 0.04, glutes: 0.06, breasts: 0 },
  nonVisiblePerFfm: 0.04,
  vat: (fm) => Math.min(0.16 * fm, 0.06 * fm + 0.0014 * fm * fm),
};

const FEMALE: SexRef = {
  H: 165,
  weight: 62,
  fat: 17.4,
  ffm: 44.6,
  smm: 24,
  torso: [
    [0.448, 10.0, 6.0, 7.0, 2.0],
    [0.474, 15.6, 7.8, 9.0, 2.0],
    [0.5, 17.4, 8.4, 9.4, 2.0],
    [0.525, 17.4, 9.0, 9.4, 2.1],
    [0.555, 15.8, 9.4, 8.8, 2.0],
    [0.58, 14.7, 9.8, 8.6, 2.0],
    [0.6, 13.9, 9.6, 8.5, 2.0],
    [0.625, 13.4, 9.2, 8.6, 2.0],
    [0.655, 13.7, 9.2, 9.1, 2.1],
    [0.685, 13.9, 9.4, 9.7, 2.2],
    [0.715, 14.6, 9.2, 10.0, 2.3],
    [0.745, 14.8, 8.8, 10.0, 2.4],
    [0.775, 14.1, 8.0, 9.2, 2.5],
    [0.8, 12.0, 6.7, 7.9, 2.4],
    [0.818, 8.4, 5.5, 6.4, 2.2],
    [0.836, 5.5, 4.7, 4.9, 2.0],
  ],
  depots: [
    { w: 0.08, yc: 0.578, sigma: 0.05, f: 0.65, b: 0, a: 0.35 }, // belly
    { w: 0.09, yc: 0.53, sigma: 0.04, f: 0, b: 0.1, a: 0.9 }, // hips
    { w: 0.04, yc: 0.712, sigma: 0.03, f: 0.7, b: 0, a: 0.3 }, // chest
    { w: 0.07, yc: 0.71, sigma: 0.06, f: 0, b: 0.6, a: 0.4 }, // upper back
    { w: 0.04, yc: 0.6, sigma: 0.045, f: 0, b: 0.6, a: 0.4 }, // lower back / flanks
  ],
  limbFat: { thigh: 0.28, calf: 0.07, upperArm: 0.08, forearm: 0.02, neckFace: 0.04, glutes: 0.13, breasts: 0.06 },
  nonVisiblePerFfm: 0.06,
  vat: (fm) => Math.min(0.15 * fm, 0.035 * fm + 0.0009 * fm * fm),
};

export const REFS = { male: MALE, female: FEMALE };

const RHO_FAT = 0.9; // kg/L adipose tissue
const CM = 0.01;

// ───────────────────────── small vector helpers ─────────────────────────
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Rotation whose local Y axis is `dir`, local Z is as close as possible to `fwd`. Row-major, columns = local axes. */
function frameFromY(dir: Vec3, fwd: Vec3 = [0, 0, 1]): number[] {
  const y = norm(dir);
  let x = cross(y, fwd);
  if (len(x) < 1e-6) x = [1, 0, 0];
  x = norm(x);
  const z = norm(cross(x, y));
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function rotZ(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function rotX(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function matMul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}

// ───────────────────────── Monotone cubic interpolation ─────────────────────────
export function monotoneSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * (xs[i + 1] - xs[i]) + (xs[i] - xs[i - 1]);
      const w2 = (xs[i + 1] - xs[i]) + 2 * (xs[i] - xs[i - 1]);
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return m;
}

// ───────────────────────── Composition helpers ─────────────────────────

export function defaultSmm(sex: Sex, ffm: number) {
  return ffm * (sex === 'male' ? 0.56 : 0.535);
}

interface FatSplit {
  sat: number;
  vat: number;
  essential: number;
}

function splitFat(ref: SexRef, fatKg: number, ffm: number, sex: Sex): FatSplit {
  const essential = Math.min(fatKg * 0.6, ref.nonVisiblePerFfm * ffm);
  let vat = ref.vat(fatKg);
  if (sex === 'female') vat = Math.min(vat, fatKg * 0.15);
  const sat = Math.max(0.05, fatKg - essential - vat);
  return { sat, vat, essential };
}

/** Depot weights slightly depend on adiposity (android shift with growing fat in men). */
function depotWeights(ref: SexRef, sex: Sex, fatKg: number) {
  const ws = ref.depots.map((d) => d.w);
  const lf = { ...ref.limbFat };
  const shift = clamp((fatKg - ref.fat) / ref.fat, -0.6, 1.5);
  if (sex === 'male') {
    ws[0] *= 1 + 0.1 * shift; // belly
    ws[1] *= 1 + 0.06 * shift; // flanks
  } else {
    ws[0] *= 1 + 0.15 * shift;
  }
  const total = ws.reduce((s, x) => s + x, 0) + Object.values(lf).reduce((s, x) => s + x, 0);
  return { ws: ws.map((w) => w / total), lf: Object.fromEntries(Object.entries(lf).map(([k, v]) => [k, v / total])) as SexRef['limbFat'] };
}

/** Ellipse-ish "shell" thickness from volume: V = L·(2π r t + π t²) */
function shellThickness(volM3: number, lengthM: number, rMean: number) {
  if (volM3 <= 0) return 0;
  return -rMean + Math.sqrt(rMean * rMean + volM3 / (Math.PI * lengthM));
}

// Torso fat deltas at height y (m) for given dims; returns [Δa, Δf, Δb] in m
function torsoFatDelta(
  depots: Depot[],
  ws: number[],
  satKg: number,
  vatKg: number,
  vatDepot: { yc: number; sigma: number },
  H: number,
  y: number,
  a: number,
  f: number,
  b: number,
): [number, number, number] {
  let da = 0,
    df = 0,
    db = 0;
  for (let i = 0; i < depots.length; i++) {
    const d = depots[i];
    const volM3 = (satKg * ws[i]) / RHO_FAT / 1000;
    const s = d.sigma * H;
    const g = Math.exp(-0.5 * ((y - d.yc * H) / s) ** 2);
    const A = (volM3 * g) / (s * Math.sqrt(2 * Math.PI)); // cross-sectional fat area at y (m²)
    // area increments: front half: π a Δf / 2 ; back half: π a Δb / 2 ; sides: π Δa (f+b) / 2
    df += (2 * A * d.f) / (Math.PI * a);
    db += (2 * A * d.b) / (Math.PI * a);
    da += (2 * A * d.a) / (Math.PI * (f + b));
  }
  // visceral: pushes abdominal wall forward
  const vs = vatDepot.sigma * H;
  const vg = Math.exp(-0.5 * ((y - vatDepot.yc * H) / vs) ** 2);
  const vA = ((vatKg / 0.92 / 1000) * vg) / (vs * Math.sqrt(2 * Math.PI));
  df += (2 * vA * 0.85) / (Math.PI * a);
  da += (2 * vA * 0.15) / (Math.PI * (f + b));
  return [da, df, db];
}

// ───────────────────────── Main builder ─────────────────────────

export function buildBody(input: BodyInput): BodySpec {
  const sex = input.sex;
  const ref = REFS[sex];
  const Hcm = clamp(input.heightCm, 120, 230);
  const H = Hcm * CM;
  const hs = Hcm / ref.H; // length scale
  const fatKg = clamp(input.fatKg, 1.5, 200);
  const ffm = clamp(input.ffm, 20, 150);
  const smm = clamp(input.smm ?? defaultSmm(sex, ffm), ffm * 0.35, ffm * 0.7);
  const refSmm = ref.smm;

  // Lean cross-scales (dimensionless, 1 under geometric similarity)
  const nmRatio = (ffm - smm) / (ref.ffm - ref.smm);
  const mmRatio = smm / refSmm;
  const leanCross = (phi: number) => Math.sqrt(((1 - phi) * nmRatio + phi * mmRatio) / hs ** 3);
  const muscleCross = Math.sqrt(mmRatio / hs ** 3);
  const muscleScale = muscleCross;

  // Fat split
  const refSplit = splitFat(ref, ref.fat, ref.ffm, sex);
  const split = splitFat(ref, fatKg, ffm, sex);
  const refW = depotWeights(ref, sex, ref.fat);
  const W = depotWeights(ref, sex, fatKg);
  const vatDepot = sex === 'male' ? { yc: 0.6, sigma: 0.058 } : { yc: 0.585, sigma: 0.05 };

  // ── Torso stations ──
  const Href = ref.H * CM;
  const torso: TorsoStation[] = [];
  let absFat = 0;
  for (const [yf, a0, f0, b0, n] of ref.torso) {
    const yRef = yf * Href;
    // reference lean dims: subtract reference fat (fixed-point, 3 iterations)
    let la = a0 * CM,
      lf = f0 * CM,
      lb = b0 * CM;
    for (let it = 0; it < 3; it++) {
      const [da, df, db] = torsoFatDelta(ref.depots, refW.ws, refSplit.sat, refSplit.vat, vatDepot, Href, yRef, la, lf, lb);
      la = Math.max(a0 * CM * 0.45, a0 * CM - da);
      lf = Math.max(f0 * CM * 0.45, f0 * CM - df);
      lb = Math.max(b0 * CM * 0.45, b0 * CM - db);
    }
    // muscle fraction: chest/back (upper) more muscular than abdomen (organs)
    const phi = yf > 0.67 ? 0.6 : yf < 0.54 ? 0.5 : 0.3;
    const cl = leanCross(phi);
    const y = yf * H;
    const ta = la * hs * cl;
    const tf = lf * hs * cl;
    const tb = lb * hs * cl;
    const [da, df, db] = torsoFatDelta(ref.depots, W.ws, split.sat, split.vat, vatDepot, H, y, ta, tf, tb);
    // front subcutaneous thickness at upper abs (≈ 0.645 H) – belly depot only (visceral doesn't hide abs)
    if (Math.abs(yf - 0.66) < 0.001 || (sex === 'female' && Math.abs(yf - 0.655) < 0.001)) {
      const [, dfs] = torsoFatDelta(ref.depots, W.ws, split.sat, 0, vatDepot, H, y, ta, tf, tb);
      absFat = dfs;
    }
    torso.push({ y, a: ta + da, f: tf + df, b: tb + db, n });
  }

  // helper: torso half-width at height y (linear interp is enough here)
  const torsoAt = (y: number) => {
    for (let i = 0; i < torso.length - 1; i++) {
      if (y >= torso[i].y && y <= torso[i + 1].y) {
        const t = (y - torso[i].y) / (torso[i + 1].y - torso[i].y);
        return {
          a: torso[i].a + (torso[i + 1].a - torso[i].a) * t,
          f: torso[i].f + (torso[i + 1].f - torso[i].f) * t,
          b: torso[i].b + (torso[i + 1].b - torso[i].b) * t,
        };
      }
    }
    return torso[y < torso[0].y ? 0 : torso.length - 1];
  };

  const prims: Prim[] = [];
  const sat = split.sat;
  const fatVol = (share: number) => (sat * share) / RHO_FAT / 1000; // m³

  // definition (how crisp muscle separations are) – from limb fat thickness
  const P = (frac: number) => frac * H; // vertical position helper
  const c = (cm: number) => cm * CM * hs; // horizontal length helper scaled by height

  // ── Legs ──
  const isM = sex === 'male';
  const hipX = c(isM ? 8.6 : 8.8);
  const hipY = P(isM ? 0.508 : 0.505);
  const kneeY = P(0.285);
  const ankleY = P(0.046);
  const kneeX = c(isM ? 9.6 : 9.0);
  const ankleX = c(isM ? 10.8 : 10.2);

  const thighLen = hipY - kneeY;
  const thighLeanCross = leanCross(0.75);
  const thighR1L = c(isM ? 8.6 : 7.6) * thighLeanCross; // lean radii at hip & above knee (ref fat removed)
  const thighR2L = c(isM ? 5.0 : 4.6) * thighLeanCross;
  // reference fat thickness for thighs → we specify lean radii directly so they already exclude fat.
  const thighVol = fatVol(W.lf.thigh) / 2;
  const thighT = shellThickness(thighVol, thighLen, (thighR1L + thighR2L) / 2 + c(1.5));
  const thighProf = isM ? [1.2, 0.8] : [1.5, 0.5];

  const calfLen = kneeY - ankleY;
  const calfLeanCross = leanCross(0.65);
  const calfR1L = c(isM ? 5.2 : 4.5) * calfLeanCross;
  const calfR2L = c(isM ? 2.9 : 2.55) * calfLeanCross;
  const calfT = shellThickness(fatVol(W.lf.calf) / 2, calfLen, (calfR1L + calfR2L) / 2 + c(1));

  // ── Arms ──
  const shX = c(isM ? 18.6 : 16.6);
  const shY = P(isM ? 0.796 : 0.79);
  const uaLen = P(0.186);
  const faLen = P(0.146);
  const handLen = P(0.108);
  const armLeanCross = leanCross(0.75);
  const uaR1L = c(isM ? 4.3 : 3.5) * armLeanCross;
  const uaR2L = c(isM ? 3.4 : 2.7) * armLeanCross;
  const uaT = shellThickness(fatVol(W.lf.upperArm) / 2, uaLen, (uaR1L + uaR2L) / 2 + c(1));
  const faLeanCross = leanCross(0.6);
  const faR1L = c(isM ? 3.9 : 3.3) * faLeanCross;
  const faR2L = c(isM ? 2.4 : 2.05) * faLeanCross;
  const faT = shellThickness(fatVol(W.lf.forearm) / 2, faLen, (faR1L + faR2L) / 2 + c(0.5));

  const definition = smoothstep(8 * 0.001, 2.5 * 0.001, (uaT + thighT) / 2);
  const absVis = isM ? smoothstep(10 * 0.001, 3.5 * 0.001, absFat) : smoothstep(9 * 0.001, 3 * 0.001, absFat);
  // blending radius between muscle bulges and limbs: crisp when lean, soft when fat
  const kMus = c(1.2) + 0.9 * (uaT + thighT) / 2 + c(1.4) * (1 - definition);

  // Arm abduction so that arms do not sink into the torso.
  const elbowY = shY - uaLen * 0.985;
  const wristY = elbowY - faLen * 0.985;
  const needAt = (y: number, reach: number, r: number) => {
    const t = torsoAt(y);
    return (t.a + r + c(2.2) - shX) / reach;
  };
  const hipLateral = hipX + thighR1L + thighT * thighProf[0] + (isM ? 0 : Math.max(0, thighT * 1.4 - c(0.3)) + c(1.5));
  const sinNeed = Math.max(
    needAt(elbowY, uaLen, uaR2L + uaT + c(0.6)),
    (Math.max(torsoAt(wristY).a, hipLateral) + faR2L + faT + c(2.6) - shX) / (uaLen + faLen),
  );
  const armAngle = clamp((Math.asin(clamp(sinNeed, 0, 0.6)) * 180) / Math.PI, isM ? 10 : 9, 34);
  const ar = (armAngle * Math.PI) / 180;
  const shoulder: Vec3 = [shX, shY, c(-0.4)];
  const elbow: Vec3 = [shX + Math.sin(ar) * uaLen, shY - Math.cos(ar) * uaLen, c(0.4)];
  const far = ar + (4 * Math.PI) / 180;
  const wrist: Vec3 = [elbow[0] + Math.sin(far) * faLen, elbow[1] - Math.cos(far) * faLen, elbow[2] + c(3.2)];

  const head = Math.pow(hs, 0.55); // head is allometric
  const hc = (cm: number) => cm * CM * head;

  // Neck / face fat
  const neckFaceVol = fatVol(W.lf.neckFace);
  const neckLen = P(0.885 - 0.83);
  const neckLeanR = c(isM ? 5.7 : 4.3) * leanCross(0.5);
  const neckT = shellThickness(neckFaceVol * 0.45, neckLen, neckLeanR);
  const faceT = Math.min(c(2.5), (neckFaceVol * 0.55) / 0.045); // spread over ~450 cm² face

  for (const side of [-1, 1] as const) {
    const sx = side;
    // ---- thigh ----
    const hip: Vec3 = [sx * hipX, hipY, c(0.4)];
    const knee: Vec3 = [sx * kneeX, kneeY, c(0.6)];
    const ankle: Vec3 = [sx * ankleX, ankleY, c(-0.6)];
    prims.push({
      kind: 'c', a: hip, b: knee,
      r1: thighR1L + thighT * thighProf[0], r2: thighR2L + thighT * thighProf[1],
      k: c(3.2), part: 'thigh', side: sx,
    });
    const thighDir = sub(knee, hip);
    const thighFrame = frameFromY(mul(thighDir, -1));
    const mus = (v: number) => v * muscleCross;
    const tmid = (t: number) => lerp3(hip, knee, t);
    // quadriceps (rectus femoris + vastus lateralis)
    prims.push({
      kind: 'e', c: add(tmid(0.47), [sx * c(1.2), 0, c(2.6)]),
      r: [mus(c(5.2)) + thighT * 0.9, thighLen * 0.36, mus(c(4.6)) + thighT * 0.9],
      R: thighFrame, k: kMus, part: 'thigh', side: sx, tag: 'quad',
    });
    // vastus medialis (teardrop)
    prims.push({
      kind: 'e', c: add(tmid(0.8), [-sx * c(2.4), 0, c(2.2)]),
      r: [mus(c(3.4)) + thighT * 0.7, thighLen * 0.15, mus(c(3.0)) + thighT * 0.7],
      R: thighFrame, k: kMus, part: 'thigh', side: sx,
    });
    // hamstrings
    prims.push({
      kind: 'e', c: add(tmid(0.45), [0, 0, -c(2.8)]),
      r: [mus(c(5.0)) + thighT, thighLen * 0.36, mus(c(4.2)) + thighT],
      R: thighFrame, k: kMus, part: 'thigh', side: sx,
    });
    // adductors (inner thigh) – where women store a lot of fat
    prims.push({
      kind: 'e', c: add(tmid(0.25), [-sx * c(2.8), 0, c(0.4)]),
      r: [mus(c(4.2)) + thighT * (isM ? 1.0 : 1.35), thighLen * 0.26, mus(c(4.6)) + thighT],
      R: thighFrame, k: kMus * 1.2, part: 'thigh', side: sx,
    });
    if (!isM) {
      // "saddlebags" – lateral upper thigh fat (gynoid)
      const sb = Math.max(0, thighT * 1.4 - c(0.3));
      prims.push({
        kind: 'e', c: add(tmid(0.16), [sx * c(3.0), 0, -c(0.8)]),
        r: [c(4.2) + sb, thighLen * 0.2, c(5.0) + sb * 0.6],
        R: thighFrame, k: c(4), part: 'thigh', side: sx,
      });
    }
    // knee cap
    prims.push({ kind: 'e', c: add(knee, [0, c(0.5), c(3.4)]), r: [c(2.6), c(2.8), c(1.6)], R: IDENT, k: c(1.6), part: 'calf', side: sx });

    // ---- calf ----
    prims.push({
      kind: 'c', a: knee, b: ankle,
      r1: calfR1L + calfT * 1.1, r2: calfR2L + calfT * 0.7,
      k: c(2.2), part: 'calf', side: sx,
    });
    const calfFrame = frameFromY(sub(knee, ankle));
    const cm2 = (t: number) => lerp3(knee, ankle, t);
    prims.push({
      kind: 'e', c: add(cm2(0.3), [-sx * c(1.4), 0, -c(2.4)]),
      r: [mus(c(isM ? 4.0 : 3.5)) + calfT, calfLen * 0.26, mus(c(isM ? 4.2 : 3.7)) + calfT],
      R: calfFrame, k: kMus * 0.9, part: 'calf', side: sx,
    });
    prims.push({
      kind: 'e', c: add(cm2(0.26), [sx * c(1.6), 0, -c(2.0)]),
      r: [mus(c(isM ? 3.5 : 3.0)) + calfT, calfLen * 0.22, mus(c(isM ? 3.7 : 3.2)) + calfT],
      R: calfFrame, k: kMus * 0.9, part: 'calf', side: sx,
    });
    // ---- foot ----
    const footLen = P(0.152);
    const toe: Vec3 = [sx * (ankleX + c(1.5)), c(1.6), ankle[2] + footLen * 0.72];
    prims.push({ kind: 'e', c: [sx * ankleX, c(3.6), ankle[2] - c(2.6)], r: [c(3.0), c(3.6), c(3.6)], R: IDENT, k: c(2), part: 'foot', side: sx });
    prims.push({ kind: 'c', a: [sx * ankleX, ankleY - c(1.5), ankle[2] + c(0.5)], b: toe, r1: c(3.4), r2: c(2.0), k: c(2.4), part: 'foot', side: sx });
    prims.push({ kind: 'e', c: add(toe, [sx * c(0.2), c(-0.1), c(-2.0)]), r: [c(4.4), c(1.7), c(3.6)], R: IDENT, k: c(2), part: 'foot', side: sx });

    // ---- glutes ----
    const gv = fatVol(W.lf.glutes) / 2;
    const gr: Vec3 = [mus(c(isM ? 7.6 : 8.2)), mus(c(isM ? 8.6 : 9.4)), mus(c(isM ? 6.0 : 6.6))];
    const gS = 4 * Math.PI * Math.pow((gr[0] * gr[1] + gr[0] * gr[2] + gr[1] * gr[2]) / 3, 1);
    const gt = gv / gS;
    prims.push({
      kind: 'e', c: [sx * c(isM ? 6.6 : 7.4), P(isM ? 0.503 : 0.5), -c(isM ? 5.0 : 5.0)],
      r: [gr[0] + gt, gr[1] + gt * 0.8, gr[2] + gt * 1.25], R: rotX(-12), k: c(2.6), part: 'torso', side: sx, tag: 'glute',
    });

    // ---- chest ----
    const chest = torsoAt(P(isM ? 0.725 : 0.715));
    if (isM) {
      prims.push({
        kind: 'e', c: [sx * c(8.4), P(0.733), chest.f - c(3.2)],
        r: [mus(c(8.4)) + absFat * 0.3, mus(c(6.2)), mus(c(3.8))],
        R: matMul(rotZ(sx * -14), rotX(-8)), k: kMus * 0.9, part: 'torso', side: sx, tag: 'pec',
      });
    } else {
      prims.push({
        kind: 'e', c: [sx * c(7.6), P(0.735), chest.f - c(2.6)],
        r: [mus(c(7.0)), mus(c(5.0)), mus(c(2.8))],
        R: rotZ(sx * -14), k: c(2.4), part: 'torso', side: sx,
      });
      const bv = (sat * W.lf.breasts) / 2 / RHO_FAT / 1000 + 0.00008; // + gland
      const br = Math.cbrt((3 * bv) / (4 * Math.PI * 1.1 * 0.85));
      const droop = clamp(br / c(7), 0.6, 1.6);
      prims.push({
        kind: 'e', c: [sx * c(9.2), P(0.708) - br * 0.3 * droop, chest.f - br * 0.05],
        r: [br * 1.2, br * 1.08, br * 0.82], R: matMul(rotZ(sx * -10), rotX(14 * droop)),
        k: c(4.2), part: 'torso', side: sx, tag: 'breast',
      });
    }
    // lats
    prims.push({
      kind: 'e', c: [sx * c(isM ? 11.2 : 10.2), P(0.705), -c(5.6)],
      r: [mus(c(isM ? 5.2 : 3.6)), mus(c(10.5)), mus(c(isM ? 4.4 : 3.6))],
      R: rotZ(sx * 12), k: c(3.2), part: 'torso', side: sx,
    });
    // trapezius
    prims.push({
      kind: 'c', a: [sx * c(2.4), P(0.852), -c(2.6)], b: [sx * (shX - c(3.2)), shY + c(1.6), -c(1.6)],
      r1: mus(c(isM ? 3.4 : 2.1)) + neckT * 0.6, r2: mus(c(isM ? 2.4 : 1.7)),
      k: c(3), part: 'torso', side: sx,
    });

    // ---- arm ----
    const sh: Vec3 = [sx * shoulder[0], shoulder[1], shoulder[2]];
    const el: Vec3 = [sx * elbow[0], elbow[1], elbow[2]];
    const wr: Vec3 = [sx * wrist[0], wrist[1], wrist[2]];
    prims.push({ kind: 'c', a: add(sh, [0, -c(1.5), 0]), b: el, r1: uaR1L * 0.92 + uaT, r2: uaR2L + uaT * 0.85, k: c(3.2), part: 'arm', side: sx });
    const uaFrame = frameFromY(sub(sh, el));
    const um = (t: number) => lerp3(sh, el, t);
    // deltoid
    prims.push({
      kind: 'e', c: add(sh, [sx * c(1.2), -c(4.2), c(0.2)]),
      r: [mus(c(isM ? 4.3 : 3.5)) + uaT, uaLen * 0.27, mus(c(isM ? 5.0 : 4.2)) + uaT],
      R: matMul(uaFrame, rotZ(0)), k: kMus, part: 'arm', side: sx, tag: 'delt',
    });
    // biceps
    prims.push({
      kind: 'e', c: add(um(0.52), [0, 0, c(1.6)]),
      r: [mus(c(isM ? 3.1 : 2.5)) + uaT * 0.8, uaLen * 0.28, mus(c(isM ? 2.9 : 2.3)) + uaT * 0.8],
      R: uaFrame, k: kMus, part: 'arm', side: sx, tag: 'biceps',
    });
    // triceps
    prims.push({
      kind: 'e', c: add(um(0.42), [0, 0, -c(1.6)]),
      r: [mus(c(isM ? 3.3 : 2.7)) + uaT * 1.2, uaLen * 0.34, mus(c(isM ? 3.2 : 2.6)) + uaT * 1.2],
      R: uaFrame, k: kMus, part: 'arm', side: sx,
    });
    // forearm
    prims.push({ kind: 'c', a: el, b: wr, r1: faR1L + faT, r2: faR2L + faT * 0.6, k: c(2.4), part: 'forearm', side: sx });
    const faFrame = frameFromY(sub(el, wr));
    prims.push({
      kind: 'e', c: add(lerp3(el, wr, 0.22), [sx * c(0.6), 0, c(0.6)]),
      r: [mus(c(isM ? 3.6 : 3.0)) + faT, faLen * 0.24, mus(c(isM ? 3.0 : 2.5)) + faT],
      R: faFrame, k: kMus, part: 'forearm', side: sx,
    });
    // hand (mitten): palm + fingers + thumb
    const hdir = norm(sub(wr, el));
    const palmC = add(wr, mul(hdir, handLen * 0.28));
    const handFrame = frameFromY(mul(hdir, -1), [sx * 1, 0, 0.15]);
    prims.push({ kind: 'e', c: palmC, r: [c(1.5), handLen * 0.27, c(isM ? 4.2 : 3.7)], R: handFrame, k: c(1.4), part: 'hand', side: sx });
    prims.push({
      kind: 'e', c: add(wr, mul(hdir, handLen * 0.68)),
      r: [c(1.1), handLen * 0.27, c(isM ? 3.9 : 3.4)], R: handFrame, k: c(1.6), part: 'hand', side: sx,
    });
    prims.push({
      kind: 'c', a: add(palmC, [0, c(1), c(2.6)]), b: add(palmC, add(mul(hdir, handLen * 0.32), [-sx * c(0.4), 0, c(4.0)])),
      r1: c(1.3), r2: c(0.8), k: c(1.2), part: 'hand', side: sx,
    });
  }

  // ── Neck & head ──
  const neckBase: Vec3 = [0, P(0.828), -c(0.8)];
  const neckTop: Vec3 = [0, P(0.888), c(0.2)];
  prims.push({ kind: 'c', a: neckBase, b: neckTop, r1: neckLeanR * 1.06 + neckT, r2: neckLeanR * 0.95 + neckT * 0.8, k: c(2.6), part: 'neck', side: 0 });
  // Sternocleidomastoid hints
  for (const sx of [-1, 1]) {
    prims.push({
      kind: 'c', a: [sx * c(1.6), P(0.842), c(3.2)], b: [sx * hc(4.2), P(0.9), -hc(0.4)],
      r1: c(1.2) * muscleCross + neckT * 0.5, r2: c(1.0) + neckT * 0.5, k: c(1.6), part: 'neck', side: sx as 1 | -1,
    });
  }
  const headTop = H;
  const cranC: Vec3 = [0, headTop - hc(isM ? 10.6 : 10.0), -hc(0.6)];
  prims.push({ kind: 'e', c: cranC, r: [hc(isM ? 7.7 : 7.3), hc(isM ? 10.4 : 9.9), hc(isM ? 9.8 : 9.3)], R: IDENT, k: c(2), part: 'head', side: 0 });
  const faceC: Vec3 = [0, headTop - hc(isM ? 16.8 : 15.8), hc(2.6)];
  prims.push({ kind: 'e', c: faceC, r: [hc(isM ? 6.2 : 5.6) + faceT, hc(7.0) + faceT * 0.4, hc(6.6) + faceT * 0.6], R: IDENT, k: hc(2.6), part: 'head', side: 0 });
  // jaw / chin
  prims.push({ kind: 'e', c: [0, headTop - hc(isM ? 21.0 : 19.8), hc(5.6)], r: [hc(isM ? 3.6 : 3.0) + faceT * 0.6, hc(2.6), hc(2.8)], R: IDENT, k: hc(2.2), part: 'head', side: 0 });
  // double chin / submental fat
  const sub_ = Math.max(0, faceT - c(0.6));
  if (sub_ > 0.001) {
    prims.push({
      kind: 'c', a: [0, headTop - hc(isM ? 20.6 : 19.4), hc(3.6)], b: [0, P(0.865), hc(1.8)],
      r1: hc(2.2) + sub_ * 1.4, r2: hc(2.6) + sub_ * 1.6, k: c(2.8), part: 'head', side: 0,
    });
  }
  // nose, brow, ears
  prims.push({ kind: 'c', a: [0, headTop - hc(11.6), hc(8.6)], b: [0, headTop - hc(14.6), hc(10.3)], r1: hc(0.7), r2: hc(1.15), k: hc(1.0), part: 'head', side: 0 });
  for (const sx of [-1, 1] as const) {
    prims.push({ kind: 'e', c: [sx * hc(7.5), headTop - hc(12.6), -hc(0.6)], r: [hc(1.0), hc(2.9), hc(1.9)], R: rotZ(sx * 8), k: hc(0.8), part: 'head', side: sx });
    // cheekbones / cheeks (fill with fat)
    prims.push({ kind: 'e', c: [sx * hc(3.6), headTop - hc(15.0), hc(4.6)], r: [hc(2.4) + faceT * 0.7, hc(2.4) + faceT * 0.5, hc(2.4) + faceT * 0.5], R: IDENT, k: hc(3.0), part: 'head', side: sx });
  }

  // ── Bounds ──
  let mn: Vec3 = [Infinity, Infinity, Infinity];
  let mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  const ext = (p: Vec3, r: number) => {
    for (let i = 0; i < 3; i++) {
      mn[i] = Math.min(mn[i], p[i] - r);
      mx[i] = Math.max(mx[i], p[i] + r);
    }
  };
  for (const s of torso) {
    ext([0, s.y, 0], 0);
    ext([s.a, s.y, s.f], 0);
    ext([-s.a, s.y, -s.b], 0);
  }
  for (const p of prims) {
    if (p.kind === 'c') {
      ext(p.a, p.r1 + p.k);
      ext(p.b, p.r2 + p.k);
    } else {
      ext(p.c, Math.max(...p.r) + p.k);
    }
  }
  const m = 0.03;
  mn = [mn[0] - m, Math.max(-0.01, mn[1] - m), mn[2] - m];
  mx = [mx[0] + m, mx[1] + m, mx[2] + m];

  const navelY = P(isM ? 0.603 : 0.6);
  const info: BodyInfo = {
    heightM: H,
    sat: split.sat,
    vat: split.vat,
    essential: split.essential,
    absVis,
    definition,
    absFatMm: absFat * 1000,
    armFatMm: uaT * 1000,
    thighFatMm: thighT * 1000,
    armAngleDeg: armAngle,
    shoulder: [shoulder[0], shoulder[1], shoulder[2]],
    muscleScale,
    levels: {
      navel: navelY,
      waist: P(isM ? 0.615 : 0.625),
      chest: P(isM ? 0.728 : 0.712),
      hips: P(isM ? 0.505 : 0.502),
      neck: P(0.85),
    },
  };

  const limbFrames: BodySpec['limbFrames'] = [
    { name: 'arm', c: lerp3([shoulder[0], shoulder[1], shoulder[2]], [elbow[0], elbow[1], elbow[2]], 0.52), axis: norm(sub(elbow, shoulder)), part: ['arm'], side: 1 },
    { name: 'forearm', c: lerp3(elbow, wrist, 0.22), axis: norm(sub(wrist, elbow)), part: ['forearm'], side: 1 },
    {
      name: 'thigh',
      c: lerp3([hipX, hipY, c(0.4)], [kneeX, kneeY, c(0.6)], 0.22),
      axis: norm(sub([kneeX, kneeY, c(0.6)], [hipX, hipY, c(0.4)])),
      part: ['thigh'],
      side: 1,
    },
    {
      name: 'calf',
      c: lerp3([kneeX, kneeY, c(0.6)], [ankleX, ankleY, -c(0.6)], 0.3),
      axis: norm(sub([ankleX, ankleY, -c(0.6)], [kneeX, kneeY, c(0.6)])),
      part: ['calf'],
      side: 1,
    },
  ];

  return { input: { ...input, fatKg, ffm, smm }, torso, prims, info, min: mn, max: mx, limbFrames };
}
