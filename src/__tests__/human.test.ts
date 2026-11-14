import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSubdiv, subdivide, type HumanData } from '../human/engine';
import { fitHuman } from '../human/fit';
import { faceRatios, fitTps, evalTps, MP_MEAN_RATIOS } from '../human/face';
import { measureFront } from '../human/photoMeasure';

function load(): HumanData {
  const dir = join(__dirname, '..', '..', 'public', 'human');
  const meta = JSON.parse(readFileSync(join(dir, 'human.json'), 'utf8'));
  const b = readFileSync(join(dir, 'human.bin'));
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const [pOff, nVerts] = meta.layout.positions;
  const data: HumanData = { base: new Float32Array(buf, pOff, nVerts * 3), nVerts, faces: {}, targets: new Map(), scale: meta.vectorScale };
  for (const [g, [off, n]] of Object.entries(meta.layout.faces) as [string, [number, number]][]) data.faces[g] = new Uint16Array(buf, off, n * 4);
  for (const t of meta.targets) data.targets.set(t.name, { idx: new Uint16Array(buf, t.idx, t.n), vec: new Int16Array(buf, t.vec, t.n * 3) });
  return data;
}

describe('realistic human', () => {
  const data = load();
  const base = { sex: 'male' as const, heightCm: 182, weight: 87.7, fatKg: 19.8, ffm: 67.9, smm: 38.2, age: 29 };

  it('has the requested height and realistic girth response to fat', () => {
    const f = fitHuman(data, base);
    const topo = buildSubdiv(data.faces.body);
    const p = subdivide(topo, f.pos, (x, y, z, o, i) => {
      o[i] = x * f.scale + f.offset[0];
      o[i + 1] = y * f.scale + f.offset[1];
      o[i + 2] = z * f.scale + f.offset[2];
    });
    let minY = Infinity,
      maxY = -Infinity;
    for (let i = 1; i < p.length; i += 3) {
      minY = Math.min(minY, p[i]);
      maxY = Math.max(maxY, p[i]);
    }
    expect(maxY - minY).toBeGreaterThan(1.78);
    expect(maxY - minY).toBeLessThan(1.84);
    const w0 = f.girths.waist;
    const w1 = fitHuman(data, { ...base, fatKg: 18.8, weight: 86.7 }).girths.waist;
    const w10 = fitHuman(data, { ...base, fatKg: 9.8, weight: 77.7 }).girths.waist;
    expect(w0 - w1).toBeGreaterThan(0.6);
    expect(w0 - w1).toBeLessThan(2.2);
    expect(w0 - w10).toBeGreaterThan(8);
    expect(w0 - w10).toBeLessThan(18);
  });

  it('personal tape measurement is reproduced at the measured composition', () => {
    const f = fitHuman(data, { ...base, persona: { girths: { hips: { cm: 108, fatKg: base.fatKg, fatShare: 0.7 } } } });
    expect(Math.abs(f.girths.hips - 108)).toBeLessThan(1.5);
  });

  it('glute-dominant fat pattern makes the buttocks bigger', () => {
    const a = fitHuman(data, base);
    const b = fitHuman(data, { ...base, pattern: { glutes: 1.9 } });
    expect(b.weights.get('buttocks/buttocks-volume-incr') ?? 0).toBeGreaterThan(a.weights.get('buttocks/buttocks-volume-incr') ?? 0);
  });
});

describe('face helpers', () => {
  it('TPS interpolates control points', () => {
    const src: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]];
    const dst: [number, number][] = [[10, 10], [20, 10], [10, 20], [20, 20], [15, 16]];
    const t = fitTps(src, dst, 0);
    const [u, v] = evalTps(t, 0.5, 0.5);
    expect(u).toBeCloseTo(15, 3);
    expect(v).toBeCloseTo(16, 3);
  });
  it('mean ratios are sane', () => {
    expect(MP_MEAN_RATIOS).toHaveLength(10);
    const r = faceRatios(() => [0, 0]);
    expect(r).toHaveLength(10);
  });
});

describe('photo measurement', () => {
  it('measures widths of a synthetic standing silhouette', () => {
    // 200×600 px person, height 600 px = 180 cm → 0.3 cm/px
    const w = 300,
      h = 640;
    const mask = new Float32Array(w * h);
    const fill = (x0: number, x1: number, y0: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 1;
    };
    fill(135, 165, 20, 90); // head
    fill(140, 160, 90, 110); // neck
    fill(100, 200, 110, 330); // torso (100 px = 30 cm)
    fill(102, 147, 330, 620); // left leg
    fill(153, 198, 330, 620); // right leg
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
    const set = (i: number, x: number, y: number) => (lm[i] = { x: x / w, y: y / h, z: 0, visibility: 1 });
    set(0, 150, 60);
    set(9, 147, 75);
    set(10, 153, 75);
    set(11, 195, 115);
    set(12, 105, 115);
    set(13, 230, 200);
    set(14, 70, 200);
    set(23, 175, 320);
    set(24, 125, 320);
    set(25, 175, 470);
    set(26, 125, 470);
    set(27, 175, 600);
    set(28, 125, 600);
    for (const i of [29, 30, 31, 32]) set(i, 150, 619);
    const m = measureFront({ w, h, lm, mask }, 180);
    expect(m.error).toBeUndefined();
    expect(m.widths.waist).toBeCloseTo(30, 0);
    expect(m.widths.thigh).toBeCloseTo(13.5, 0);
  });
});
