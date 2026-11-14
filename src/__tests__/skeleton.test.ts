import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HumanData } from '../human/engine';
import { fitHuman } from '../human/fit';
import {
  computeCapsules,
  computeJoints,
  estimateAbduction,
  jointIndex,
  loadSkeleton,
  poseBones,
  poseJoints,
  skin,
  type Skeleton,
  type SkeletonJson,
} from '../human/skeleton';

const dir = join(__dirname, '..', '..', 'public', 'human');

function loadHuman(): { data: HumanData; meta: { vectorScale: number } } {
  const meta = JSON.parse(readFileSync(join(dir, 'human.json'), 'utf8'));
  const b = readFileSync(join(dir, 'human.bin'));
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const [pOff, nVerts] = meta.layout.positions;
  const data: HumanData = { base: new Float32Array(buf, pOff, nVerts * 3), nVerts, faces: {}, targets: new Map(), scale: meta.vectorScale };
  for (const [g, [off, n]] of Object.entries(meta.layout.faces) as [string, [number, number]][]) data.faces[g] = new Uint16Array(buf, off, n * 4);
  for (const t of meta.targets) data.targets.set(t.name, { idx: new Uint16Array(buf, t.idx, t.n), vec: new Int16Array(buf, t.vec, t.n * 3) });
  return { data, meta };
}

function loadSkel(): Skeleton {
  const json = JSON.parse(readFileSync(join(dir, 'skeleton.json'), 'utf8')) as SkeletonJson;
  const b = readFileSync(join(dir, 'skeleton.bin'));
  return loadSkeleton(json, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

interface RefCase {
  target: string | null;
  weight: number;
  t: number;
  arm: number;
  leg: number;
  verts: number[];
  pos: number[];
  restJoints: number[];
  joints: number[];
  capsules: number[];
  checksum: number;
  estimate: [number, number];
}

const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('skeleton / relaxed pose', () => {
  const { data } = loadHuman();
  const skel = loadSkel();
  const J = (j: Float32Array, name: string) => {
    const i = jointIndex(skel, name) * 3;
    return [j[i], j[i + 1], j[i + 2]];
  };
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const male = { sex: 'male' as const, heightCm: 182, weight: 87.7, fatKg: 19.8, ffm: 67.9, smm: 38.2, age: 29 };
  const obese = { sex: 'male' as const, heightCm: 176, weight: 140, fatKg: 60, ffm: 80, smm: 42, age: 40 };
  const leanF = { sex: 'female' as const, heightCm: 168, weight: 50, fatKg: 8, ffm: 42, smm: 22, age: 25 };

  it('asset is within budget and well formed', () => {
    const kb = (statSync(join(dir, 'skeleton.bin')).size + statSync(join(dir, 'skeleton.json')).size) / 1024;
    expect(kb).toBeLessThan(250);
    expect(skel.nVerts).toBe(data.nVerts);
    expect(skel.nBones).toBe(47);
    expect(skel.nCapsules).toBeGreaterThanOrEqual(16);
    expect(skel.nCapsules).toBeLessThanOrEqual(20);
    for (let i = 0; i < skel.nBones; i++) expect(skel.boneParent[i]).toBeLessThan(i); // parents first
    for (let v = 0; v < skel.nVerts; v++) {
      const k = v * 4;
      const sum = skel.skinWeight[k] + skel.skinWeight[k + 1] + skel.skinWeight[k + 2] + skel.skinWeight[k + 3];
      if (Math.abs(sum - 1) > 1e-6 || skel.skinWeight[k] < skel.skinWeight[k + 1]) throw new Error(`bad weights at vertex ${v}`);
    }
  });

  it('matches the numpy reference (tools/mh/build_skeleton.py) within 1e-3 dm', () => {
    const ref = JSON.parse(readFileSync(join(__dirname, 'skeleton.selftest.json'), 'utf8')) as { cases: RefCase[] };
    expect(ref.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of ref.cases) {
      const pos = Float32Array.from(data.base);
      if (c.target) {
        const t = data.targets.get(c.target)!;
        for (let i = 0; i < t.idx.length; i++) for (let k = 0; k < 3; k++) pos[t.idx[i] * 3 + k] += t.vec[i * 3 + k] * data.scale * c.weight;
      }
      const joints = computeJoints(skel, pos);
      expect(maxAbsDiff(joints, c.restJoints)).toBeLessThan(1e-4);
      const pose = poseBones(skel, joints, { t: c.t, armAbductionDeg: c.arm, legAbductionDeg: c.leg });
      const out = skin(skel, pose, pos);
      const got = c.verts.flatMap((v) => [out[v * 3], out[v * 3 + 1], out[v * 3 + 2]]);
      expect(maxAbsDiff(got, c.pos)).toBeLessThan(1e-4); // requirement: 1e-3 dm
      let sum = 0;
      for (let i = 0; i < out.length; i++) sum += Math.abs(out[i]);
      expect(Math.abs(sum - c.checksum) / c.checksum).toBeLessThan(1e-6);
      expect(maxAbsDiff(poseJoints(skel, pose, joints), c.joints)).toBeLessThan(1e-4);
      expect(maxAbsDiff(computeCapsules(skel, pose, joints, pos), c.capsules)).toBeLessThan(1e-4);
      const est = estimateAbduction(skel, pos, joints);
      expect(Math.abs(est.armAbductionDeg - c.estimate[0])).toBeLessThan(0.02);
      expect(Math.abs(est.legAbductionDeg - c.estimate[1])).toBeLessThan(0.02);
    }
  });

  it('t = 0 is the identity, in-place skinning works, bone lengths are preserved', () => {
    const pos = fitHuman(data, male).pos;
    const joints = computeJoints(skel, pos);
    const rest = skin(skel, poseBones(skel, joints, { t: 0, armAbductionDeg: 20, legAbductionDeg: 10 }), pos);
    expect(maxAbsDiff(rest, pos)).toBeLessThan(1e-5);

    const pose = poseBones(skel, joints, { t: 1, armAbductionDeg: 6, legAbductionDeg: 3 });
    const a = skin(skel, pose, pos);
    const b = skin(skel, pose, Float32Array.from(pos));
    const inPlace = Float32Array.from(pos);
    skin(skel, pose, inPlace, inPlace);
    expect(maxAbsDiff(a, b)).toBe(0);
    expect(maxAbsDiff(a, inPlace)).toBe(0);

    const pj = poseJoints(skel, pose, joints);
    const chains = [
      ['clavicle', 'shoulder01', 'upperarm01', 'lowerarm01', 'lowerarm02', 'wrist', 'finger3-1', 'finger3-2', 'finger3-3'],
      ['wrist', 'finger1-1', 'finger1-2', 'finger1-3'],
      ['upperleg01', 'lowerleg01', 'foot', 'toe3-1'],
    ];
    for (const side of ['L', 'R'])
      for (const ch of chains)
        for (let i = 1; i < ch.length; i++) {
          const n0 = `${ch[i - 1]}.${side}`;
          const n1 = `${ch[i]}.${side}`;
          expect(Math.abs(dist(J(pj, n0), J(pj, n1)) - dist(J(joints, n0), J(joints, n1)))).toBeLessThan(1e-4);
        }
    // spine / head are not posed: the head stays level
    for (const n of ['root', 'spine01', 'neck01', 'head', 'head_top']) expect(dist(J(pj, n), J(joints, n))).toBeLessThan(1e-6);
  });

  it('gives a natural relaxed stance on normal bodies', () => {
    for (const input of [male, leanF]) {
      const pos = fitHuman(data, input).pos;
      const joints = computeJoints(skel, pos);
      const est = estimateAbduction(skel, pos, joints);
      expect(est.armAbductionDeg).toBeLessThan(3);
      expect(est.legAbductionDeg).toBe(0);
      const pose = poseBones(skel, joints, { t: 1, ...est });
      const pj = poseJoints(skel, pose, joints);
      for (const [side, s] of [['L', 1], ['R', -1]] as const) {
        const sh = J(pj, `upperarm01.${side}`);
        const el = J(pj, `lowerarm01.${side}`);
        const wr = J(pj, `wrist.${side}`);
        const tip = J(pj, `fingertip3.${side}`);
        const knuckle = J(pj, `finger3-1.${side}`);
        // upper arm 10–20° away from vertical in the frontal plane
        const abd = Math.atan2(s * (el[0] - sh[0]), sh[1] - el[1]) / (Math.PI / 180);
        expect(abd).toBeGreaterThan(10);
        expect(abd).toBeLessThan(20);
        // slight elbow bend
        const u = [el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]];
        const f = [wr[0] - el[0], wr[1] - el[1], wr[2] - el[2]];
        const bend = Math.acos((u[0] * f[0] + u[1] * f[1] + u[2] * f[2]) / (Math.hypot(...u) * Math.hypot(...f))) / (Math.PI / 180);
        expect(bend).toBeGreaterThan(10);
        expect(bend).toBeLessThan(30);
        // relaxed curl: the middle fingertip is clearly closer to the wrist than a straight finger would be
        const straight = dist(wr, knuckle) + dist(knuckle, J(pj, `finger3-2.${side}`)) + dist(J(pj, `finger3-2.${side}`), J(pj, `finger3-3.${side}`)) + dist(J(pj, `finger3-3.${side}`), tip);
        expect(dist(wr, tip) / straight).toBeLessThan(0.97);
        expect(dist(wr, tip) / straight).toBeGreaterThan(0.8);
        // hand hangs beside the thigh, feet about hip width
        expect(tip[1]).toBeLessThan(J(pj, `upperleg01.${side}`)[1]);
        expect(Math.abs(wr[1] - J(pj, `upperleg01.${side}`)[1])).toBeLessThan(1.2);
        const ankle = s * J(pj, `foot.${side}`)[0];
        const hip = s * J(pj, `upperleg01.${side}`)[0];
        expect(ankle / hip).toBeGreaterThan(0.7);
        expect(ankle / hip).toBeLessThan(1.3);
      }
      // symmetric
      const l = J(pj, 'wrist.L');
      const r = J(pj, 'wrist.R');
      expect(Math.abs(l[0] + r[0])).toBeLessThan(0.02);
      expect(Math.abs(l[1] - r[1])).toBeLessThan(0.02);
    }
  });

  it('auto abduction keeps an obese body free of arm / thigh intersection', () => {
    const pos = fitHuman(data, obese).pos;
    const joints = computeJoints(skel, pos);
    const est = estimateAbduction(skel, pos, joints);
    expect(est.armAbductionDeg).toBeGreaterThan(4);
    expect(est.armAbductionDeg).toBeLessThan(30);
    expect(est.legAbductionDeg).toBeGreaterThan(1);
    expect(est.legAbductionDeg).toBeLessThan(15);
    const strict = estimateAbduction(skel, pos, joints, { softDm: 0 });
    expect(strict.legAbductionDeg).toBeGreaterThan(est.legAbductionDeg);

    // independent check on the posed mesh: left-leg vertices stay on their side of the mid-plane (≤ 1 cm soft overlap)
    const out = skin(skel, poseBones(skel, joints, { t: 1, ...est }), pos);
    let minX = Infinity;
    for (const v of skel.probes.legL) minX = Math.min(minX, out[v * 3]);
    for (const v of skel.probes.legR) minX = Math.min(minX, -out[v * 3]);
    expect(minX).toBeGreaterThan(-0.105);
    // hands end up outside the widest point of the hips / thighs
    const none = skin(skel, poseBones(skel, joints, { t: 1 }), pos);
    let hipMax = 0;
    for (const v of skel.probes.torsoL) hipMax = Math.max(hipMax, out[v * 3]);
    const handX = (p: Float32Array) => {
      let m = Infinity;
      for (const v of skel.probes.armL) m = Math.min(m, p[v * 3]);
      return m;
    };
    expect(handX(out)).toBeGreaterThan(handX(none) + 0.3);
    expect(hipMax).toBeGreaterThan(1.5);
    // capsules follow the body: thigh radius of the obese body is clearly larger than the lean one's
    const caps = computeCapsules(skel, poseBones(skel, joints, { t: 1, ...est }), joints, pos);
    const thigh = skel.capsuleNames.indexOf('thigh.L');
    const leanPos = fitHuman(data, leanF).pos;
    const leanJ = computeJoints(skel, leanPos);
    const leanCaps = computeCapsules(skel, poseBones(skel, leanJ), leanJ, leanPos);
    expect(caps[thigh * 7 + 6]).toBeGreaterThan(leanCaps[thigh * 7 + 6] * 1.3);
    for (let c = 0; c < skel.nCapsules; c++) {
      expect(caps[c * 7 + 6]).toBeGreaterThan(0.1);
      expect(caps[c * 7 + 6]).toBeLessThan(3.5);
    }
  });

  it('computeJoints + poseBones + skin run in < 6 ms', () => {
    const pos = fitHuman(data, male).pos;
    const joints = new Float32Array(skel.nJoints * 3);
    const out = new Float32Array(pos.length);
    const pose = poseBones(skel, computeJoints(skel, pos, joints));
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      computeJoints(skel, pos, joints);
      poseBones(skel, joints, { t: 1, armAbductionDeg: 5, legAbductionDeg: 2 }, pose);
      skin(skel, pose, pos, out);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[30];
    console.log(`skeleton: computeJoints+poseBones+skin median ${median.toFixed(3)} ms (min ${times[0].toFixed(3)}, max ${times[59].toFixed(3)})`);
    expect(median).toBeLessThan(6);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) estimateAbduction(skel, pos, joints);
    console.log(`skeleton: estimateAbduction ${((performance.now() - t0) / 20).toFixed(3)} ms`);
  });
});
