/**
 * Body measurements from two photos (front + side) using the MediaPipe pose landmarks and person mask.
 * Height (known) gives the scale; widths (front) and depths (side) at anatomical levels → elliptic girths.
 */
import type { PoseResult } from './vision';

export type Level = 'neck' | 'chest' | 'waist' | 'hips' | 'thigh' | 'calf' | 'arm';

export interface Line {
  level: Level;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SideMeasure {
  cmPerPx: number;
  widths: Partial<Record<Level, number>>; // cm
  lines: Line[];
  fracWaist?: number;
  error?: string;
}

const P = (r: PoseResult, i: number) => ({ x: r.lm[i].x * r.w, y: r.lm[i].y * r.h, v: r.lm[i].visibility ?? 1 });

function on(r: PoseResult, x: number, y: number) {
  const xi = Math.round(x),
    yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= r.w || yi >= r.h) return false;
  return r.mask[yi * r.w + xi] > 0.5;
}

/** Horizontal silhouette run at row y containing (or nearest to) x. */
function runAt(r: PoseResult, y: number, x: number): [number, number] | null {
  let sx = Math.round(x);
  if (!on(r, sx, y)) {
    let found = false;
    for (let d = 1; d < 12; d++) {
      if (on(r, sx + d, y)) {
        sx += d;
        found = true;
        break;
      }
      if (on(r, sx - d, y)) {
        sx -= d;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  let l = sx,
    rr = sx;
  while (on(r, l - 1, y)) l--;
  while (on(r, rr + 1, y)) rr++;
  return [l, rr];
}

/** Run along an arbitrary direction (unit dx, dy) through point (x, y). */
function runDir(r: PoseResult, x: number, y: number, dx: number, dy: number): [number, number] | null {
  if (!on(r, x, y)) return null;
  let a = 0,
    b = 0;
  while (on(r, x - dx * (a + 1), y - dy * (a + 1)) && a < 2000) a++;
  while (on(r, x + dx * (b + 1), y + dy * (b + 1)) && b < 2000) b++;
  return [-a, b];
}

function verticalExtent(r: PoseResult): [number, number] | null {
  let top = -1,
    bottom = -1;
  for (let y = 0; y < r.h; y++) {
    let c = 0;
    for (let x = 0; x < r.w; x++) if (r.mask[y * r.w + x] > 0.5) c++;
    if (c >= 3) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return top < 0 ? null : [top, bottom];
}

function checkFull(r: PoseResult): string | undefined {
  const need = [0, 11, 12, 23, 24, 25, 26, 27, 28];
  for (const i of need) if ((r.lm[i].visibility ?? 1) < 0.4) return 'В кадре должно быть всё тело — от макушки до стоп.';
  const ext = verticalExtent(r);
  if (!ext) return 'Не удалось найти человека на фото.';
  if (ext[0] <= 2 || ext[1] >= r.h - 2) return 'Тело обрезано краем кадра — отойди дальше.';
  return undefined;
}

export function measureFront(r: PoseResult, heightCm: number): SideMeasure {
  const err = checkFull(r);
  const lines: Line[] = [];
  if (err) return { cmPerPx: 0, widths: {}, lines, error: err };
  const [top, bottom0] = verticalExtent(r)!;
  const heel = Math.max(P(r, 29).y, P(r, 30).y, P(r, 31).y, P(r, 32).y);
  const bottom = Math.max(bottom0, heel);
  const k = heightCm / (bottom - top);
  const shY = (P(r, 11).y + P(r, 12).y) / 2;
  const hipY = (P(r, 23).y + P(r, 24).y) / 2;
  const cx = (P(r, 11).x + P(r, 12).x + P(r, 23).x + P(r, 24).x) / 4;
  const L = hipY - shY;
  const shoulderSpan = Math.abs(P(r, 11).x - P(r, 12).x);
  const widths: Partial<Record<Level, number>> = {};
  const add = (level: Level, y: number, run: [number, number] | null) => {
    if (!run) return;
    widths[level] = (run[1] - run[0]) * k;
    lines.push({ level, x0: run[0], y0: y, x1: run[1], y1: y });
  };
  // chest
  const chestY = shY + 0.28 * L;
  const chest = runAt(r, chestY, cx);
  if (chest && chest[1] - chest[0] < shoulderSpan * 1.6) add('chest', chestY, chest);
  // waist: narrowest torso width
  let best: { y: number; run: [number, number] } | null = null;
  for (let y = shY + 0.5 * L; y <= shY + 0.9 * L; y += 2) {
    const ru = runAt(r, y, cx);
    if (ru && (!best || ru[1] - ru[0] < best.run[1] - best.run[0])) best = { y, run: ru };
  }
  let fracWaist: number | undefined;
  if (best) {
    add('waist', best.y, best.run);
    fracWaist = (best.y - shY) / L;
  }
  // hips: widest before the legs separate
  let hb: { y: number; run: [number, number] } | null = null;
  const kneeY = (P(r, 25).y + P(r, 26).y) / 2;
  for (let y = hipY - 0.05 * L; y <= hipY + 0.35 * L && y < kneeY; y += 2) {
    const ru = runAt(r, y, cx);
    if (!ru) break;
    // legs separated? centre column off-mask
    if (!on(r, cx, y)) break;
    if (!hb || ru[1] - ru[0] > hb.run[1] - hb.run[0]) hb = { y, run: ru };
  }
  if (hb) add('hips', hb.y, hb.run);
  // thighs & calves – average both legs
  const legW = (level: Level, a: number, b: number, from: number, to: number, mode: 'at' | 'max') => {
    const vals: number[] = [];
    for (const [hi, ki] of [
      [a, b],
      [a + 1, b + 1],
    ]) {
      const A = P(r, hi),
        B = P(r, ki);
      let bestRun: { y: number; run: [number, number] } | null = null;
      const steps = mode === 'at' ? [from] : Array.from({ length: 12 }, (_, i) => from + ((to - from) * i) / 11);
      for (const t of steps) {
        const y = A.y + (B.y - A.y) * t;
        const x = A.x + (B.x - A.x) * t;
        const ru = runAt(r, y, x);
        if (ru && (!bestRun || ru[1] - ru[0] > bestRun.run[1] - bestRun.run[0])) bestRun = { y, run: ru };
      }
      if (bestRun && bestRun.run[1] - bestRun.run[0] < L * 0.9) {
        vals.push((bestRun.run[1] - bestRun.run[0]) * k);
        lines.push({ level, x0: bestRun.run[0], y0: bestRun.y, x1: bestRun.run[1], y1: bestRun.y });
      }
    }
    if (vals.length) widths[level] = vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  legW('thigh', 23, 25, 0.25, 0.25, 'at');
  legW('calf', 25, 27, 0.15, 0.5, 'max');
  // upper arm: perpendicular to shoulder→elbow at the middle
  const armVals: number[] = [];
  for (const [s, e] of [
    [11, 13],
    [12, 14],
  ]) {
    const S = P(r, s),
      E = P(r, e);
    const mx = (S.x + E.x) / 2,
      my = (S.y + E.y) / 2;
    const len = Math.hypot(E.x - S.x, E.y - S.y) || 1;
    const px = -(E.y - S.y) / len,
      py = (E.x - S.x) / len;
    const ru = runDir(r, mx, my, px, py);
    if (ru) {
      const w = (ru[1] - ru[0]) * k;
      if (w > 5 && w < 25) {
        armVals.push(w);
        lines.push({ level: 'arm', x0: mx + px * ru[0], y0: my + py * ru[0], x1: mx + px * ru[1], y1: my + py * ru[1] });
      }
    }
  }
  if (armVals.length) widths.arm = armVals.reduce((s, v) => s + v, 0) / armVals.length;
  // neck: narrowest between mouth and shoulders
  const mouthY = (P(r, 9).y + P(r, 10).y) / 2;
  let nb: { y: number; run: [number, number] } | null = null;
  const nx = P(r, 0).x;
  for (let y = mouthY + 0.35 * (shY - mouthY); y <= shY - 0.1 * (shY - mouthY); y += 1) {
    const ru = runAt(r, y, nx);
    if (ru && (!nb || ru[1] - ru[0] < nb.run[1] - nb.run[0])) nb = { y, run: ru };
  }
  if (nb) add('neck', nb.y, nb.run);
  return { cmPerPx: k, widths, lines, fracWaist };
}

export function measureSide(r: PoseResult, heightCm: number, fracWaist = 0.7): SideMeasure {
  const err = checkFull(r);
  const lines: Line[] = [];
  if (err) return { cmPerPx: 0, widths: {}, lines, error: err };
  const [top, bottom0] = verticalExtent(r)!;
  const heel = Math.max(P(r, 29).y, P(r, 30).y, P(r, 31).y, P(r, 32).y);
  const k = heightCm / (Math.max(bottom0, heel) - top);
  const shY = (P(r, 11).y + P(r, 12).y) / 2;
  const hipY = (P(r, 23).y + P(r, 24).y) / 2;
  const L = hipY - shY;
  const cxAt = (y: number) => {
    const t = (y - shY) / L;
    const sx = (P(r, 11).x + P(r, 12).x) / 2;
    const hx = (P(r, 23).x + P(r, 24).x) / 2;
    return sx + (hx - sx) * t;
  };
  const widths: Partial<Record<Level, number>> = {};
  const add = (level: Level, y: number, run: [number, number] | null) => {
    if (!run) return;
    widths[level] = (run[1] - run[0]) * k;
    lines.push({ level, x0: run[0], y0: y, x1: run[1], y1: y });
  };
  const chestY = shY + 0.28 * L;
  add('chest', chestY, runAt(r, chestY, cxAt(chestY)));
  const wy = shY + fracWaist * L;
  add('waist', wy, runAt(r, wy, cxAt(wy)));
  let hb: { y: number; run: [number, number] } | null = null;
  for (let y = hipY - 0.05 * L; y <= hipY + 0.35 * L; y += 2) {
    const ru = runAt(r, y, cxAt(Math.min(y, hipY)));
    if (ru && (!hb || ru[1] - ru[0] > hb.run[1] - hb.run[0])) hb = { y, run: ru };
  }
  if (hb) add('hips', hb.y, hb.run);
  const kneeY = (P(r, 25).y + P(r, 26).y) / 2;
  const kneeX = (P(r, 25).x + P(r, 26).x) / 2;
  const hipX = (P(r, 23).x + P(r, 24).x) / 2;
  const ty = hipY + 0.25 * (kneeY - hipY);
  add('thigh', ty, runAt(r, ty, hipX + (kneeX - hipX) * 0.25));
  const ankleY = (P(r, 27).y + P(r, 28).y) / 2;
  const ankleX = (P(r, 27).x + P(r, 28).x) / 2;
  let cb: { y: number; run: [number, number] } | null = null;
  for (let t = 0.15; t <= 0.5; t += 0.03) {
    const y = kneeY + (ankleY - kneeY) * t;
    const ru = runAt(r, y, kneeX + (ankleX - kneeX) * t);
    if (ru && (!cb || ru[1] - ru[0] > cb.run[1] - cb.run[0])) cb = { y, run: ru };
  }
  if (cb) add('calf', cb.y, cb.run);
  const mouthY = (P(r, 9).y + P(r, 10).y) / 2;
  let nb: { y: number; run: [number, number] } | null = null;
  for (let y = mouthY + 0.35 * (shY - mouthY); y <= shY - 0.1 * (shY - mouthY); y += 1) {
    const ru = runAt(r, y, (P(r, 7).x + P(r, 8).x + P(r, 11).x + P(r, 12).x) / 4);
    if (ru && (!nb || ru[1] - ru[0] < nb.run[1] - nb.run[0])) nb = { y, run: ru };
  }
  if (nb) add('neck', nb.y, nb.run);
  return { cmPerPx: k, widths, lines };
}

const ellipse = (w: number, d: number) => {
  const a = w / 2,
    b = d / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
};

const SHAPE_K: Record<Level, number> = { neck: 0.98, chest: 0.99, waist: 0.98, hips: 0.97, thigh: 0.97, calf: 0.97, arm: 0.97 };

export function girthsFromPhotos(front: SideMeasure, side: SideMeasure | null): Partial<Record<Level, number>> {
  const out: Partial<Record<Level, number>> = {};
  for (const lv of ['neck', 'chest', 'waist', 'hips', 'thigh', 'calf'] as Level[]) {
    const w = front.widths[lv];
    const d = side?.widths[lv];
    if (!w) continue;
    if (d) out[lv] = ellipse(w, d) * SHAPE_K[lv];
  }
  if (front.widths.arm) out.arm = Math.PI * front.widths.arm * SHAPE_K.arm;
  return out;
}
