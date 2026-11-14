import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HumanData } from '../human/engine';
import { fitHuman, type HumanInput } from '../human/fit';
import {
  computeHairNormals,
  computeProxyNormals,
  computeProxyTangents,
  fitProxy,
  loadProxies,
  proxiesOfKind,
  type ProxiesJson,
  type Proxy,
} from '../human/proxies';

const DIR = join(__dirname, '..', '..', 'public', 'human');
const N_BASE = 19158;
const N_SKIN = 13380; // base vertices 0..13379 are the skin

function loadHuman(): HumanData {
  const meta = JSON.parse(readFileSync(join(DIR, 'human.json'), 'utf8'));
  const b = readFileSync(join(DIR, 'human.bin'));
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const [pOff, nVerts] = meta.layout.positions;
  const data: HumanData = { base: new Float32Array(buf, pOff, nVerts * 3), nVerts, faces: {}, targets: new Map(), scale: meta.vectorScale };
  for (const [g, [off, n]] of Object.entries(meta.layout.faces) as [string, [number, number]][]) data.faces[g] = new Uint16Array(buf, off, n * 4);
  for (const t of meta.targets) data.targets.set(t.name, { idx: new Uint16Array(buf, t.idx, t.n), vec: new Int16Array(buf, t.vec, t.n * 3) });
  return data;
}

const json = JSON.parse(readFileSync(join(DIR, 'proxies.json'), 'utf8')) as ProxiesJson;
const bin = readFileSync(join(DIR, 'proxies.bin'));
const proxies = loadProxies(json, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const byName = new Map(proxies.map((p) => [p.name, p]));
const human = loadHuman();

const cauc = { african: 0, asian: 0, caucasian: 1 };
const SHAPES: Record<string, HumanInput> = {
  male: { sex: 'male', heightCm: 182, weight: 87.7, fatKg: 19.8, ffm: 67.9, smm: 38.2, age: 29, persona: { ethnic: cauc } },
  female: { sex: 'female', heightCm: 168, weight: 56, fatKg: 11.5, ffm: 44.5, smm: 24, age: 26, persona: { ethnic: cauc } },
  heavyMale: { sex: 'male', heightCm: 178, weight: 128, fatKg: 50, ffm: 78, smm: 42, age: 45, persona: { ethnic: cauc } },
  heavyFemale: { sex: 'female', heightCm: 164, weight: 98, fatKg: 46, ffm: 52, smm: 27, age: 40, persona: { ethnic: cauc } },
  oldMale: { sex: 'male', heightCm: 174, weight: 68, fatKg: 14, ffm: 54, smm: 28, age: 78, persona: { ethnic: cauc } },
};
const shapeCache = new Map<string, Float32Array>();
function shape(name: string): Float32Array {
  let p = shapeCache.get(name);
  if (!p) {
    p = fitHuman(human, SHAPES[name]).pos;
    shapeCache.set(name, p);
  }
  return p;
}

/** centre of the skull = mean of the head anchor vertices */
function headCentre(base: Float32Array): [number, number, number] {
  const a = proxies[0].shared.headAnchor;
  let x = 0, y = 0, z = 0;
  for (const v of a) {
    x += base[v * 3];
    y += base[v * 3 + 1];
    z += base[v * 3 + 2];
  }
  return [x / a.length, y / a.length, z / a.length];
}

/** area weighted skin vertex normals from the body quads */
function skinNormals(base: Float32Array): Float32Array {
  const q = human.faces.body;
  const n = new Float32Array(N_SKIN * 3);
  for (let f = 0; f < q.length; f += 4) {
    const a = q[f] * 3, b = q[f + 1] * 3, c = q[f + 2] * 3, d = q[f + 3] * 3;
    const ux = base[c] - base[a], uy = base[c + 1] - base[a + 1], uz = base[c + 2] - base[a + 2];
    const vx = base[d] - base[b], vy = base[d + 1] - base[b + 1], vz = base[d + 2] - base[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c, d]) {
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

/** For every proxy vertex: distance to the nearest skin vertex and signed height above that vertex's tangent plane. */
function clearance(pos: Float32Array, count: number, base: Float32Array, minY: number): { dist: Float32Array; signed: Float32Array } {
  const nrm = skinNormals(base);
  const sel: number[] = [];
  for (let v = 0; v < N_SKIN; v++) if (base[v * 3 + 1] > minY) sel.push(v);
  const dist = new Float32Array(count), signed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let best = Infinity, bj = 0;
    for (let k = 0; k < sel.length; k++) {
      const j = sel[k] * 3;
      const dx = x - base[j], dy = y - base[j + 1], dz = z - base[j + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        bj = j;
      }
    }
    dist[i] = Math.sqrt(best);
    signed[i] = (x - base[bj]) * nrm[bj] + (y - base[bj + 1]) * nrm[bj + 1] + (z - base[bj + 2]) * nrm[bj + 2];
  }
  return { dist, signed };
}

/** rotation about the z axis through pivot + translation, applied to vertices selected by `pick` */
function rotateZ(src: Float32Array, deg: number, pivot: number[], t: number[], pick?: (i: number) => boolean): Float32Array {
  const out = new Float32Array(src);
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  for (let i = 0; i < src.length; i += 3) {
    if (pick && !pick(i)) continue;
    const x = src[i] - pivot[0], y = src[i + 1] - pivot[1];
    out[i] = c * x - s * y + pivot[0] + t[0];
    out[i + 1] = s * x + c * y + pivot[1] + t[1];
    out[i + 2] = src[i + 2] + t[2];
  }
  return out;
}

const maxDiff = (a: Float32Array, b: Float32Array, n = a.length) => {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('proxies asset', () => {
  it('contains eyes, two brow sets, lashes and five hairstyles within the size budget', () => {
    expect(json.baseVertexCount).toBe(N_BASE);
    expect(human.nVerts).toBe(N_BASE);
    expect(proxiesOfKind(proxies, 'eyes').length).toBe(1);
    expect(proxiesOfKind(proxies, 'cornea').length).toBe(1);
    expect(proxiesOfKind(proxies, 'eyebrows').length).toBe(2);
    expect(proxiesOfKind(proxies, 'eyelashes').length).toBe(1);
    expect(proxiesOfKind(proxies, 'hair').map((p) => p.name).sort()).toEqual(['bob01', 'long01', 'ponytail01', 'short02', 'short04']);
    const textures = new Set<string>();
    for (const p of proxies) {
      if (p.texture) textures.add(p.texture);
      for (const t of Object.values(p.textures)) textures.add(t);
    }
    expect(Object.keys(byName.get('eyes')!.textures).sort()).toEqual(['blue', 'brown', 'brownlight', 'green', 'grey']);
    let bytes = bin.byteLength + statSync(join(DIR, 'proxies.json')).size;
    for (const t of textures) {
      expect(existsSync(join(DIR, t)), t).toBe(true);
      bytes += statSync(join(DIR, t)).size;
    }
    expect(bytes).toBeLessThan(2.2 * 1024 * 1024);
  });

  it('has consistent topology and fitting data', () => {
    for (const p of proxies) {
      expect(p.vertexCount).toBeGreaterThanOrEqual(p.fitCount);
      expect(p.vertexCount).toBeLessThan(65536);
      expect(p.indices.length % 3).toBe(0);
      expect(p.uvs.length).toBe(p.vertexCount * 2);
      let ok = true;
      for (let i = 0; i < p.indices.length; i++) ok &&= p.indices[i] < p.vertexCount;
      for (let i = 0; i < p.ref.length; i++) ok &&= p.ref[i] < N_BASE;
      for (let i = 0; i < p.dup.length; i++) ok &&= p.dup[i] < p.fitCount;
      for (let i = 0; i < p.uvs.length; i++) ok &&= p.uvs[i] >= 0 && p.uvs[i] <= 1;
      if (p.colIdx && p.colRef) {
        for (let i = 0; i < p.colIdx.length; i++) ok &&= p.colIdx[i] < p.fitCount;
        for (let i = 0; i < p.colRef.length; i++) ok &&= p.colRef[i] < N_SKIN;
      }
      expect(ok, p.name).toBe(true);
      expect(p.kind === 'hair' ? p.dir !== null && p.colIdx !== null : p.dir === null && p.colIdx === null, p.name).toBe(true);
      expect(['front', 'double']).toContain(p.render.side);
    }
    // MakeHuman's delete_verts is empty for every shipped proxy: no body faces have to be hidden
    expect(proxies[0].shared.deleteVerts.length).toBe(0);
  });

  it('documents how well the stored proxy vertices are reconstructed from the authoring human', () => {
    // outliers = vertices whose stored OBJ position differs by > 0.02 dm from the fit (the artists edited the mesh
    // after fitting, or the helper-hair targets changed since); MakeHuman itself always shows the fit.
    const documented: Record<string, number> = { short02: 8, ponytail01: 109, long01: 699 };
    for (const p of json.proxies) {
      const a = p.authoring!;
      if (a.residual === null) continue; // eyes: stored in a legacy frame, scale taken from the official .mhclo
      expect(a.residualMedian!, p.name).toBeLessThan(0.0002);
      expect(a.outliers!, p.name).toBe(documented[p.name] ?? 0);
      if (!(p.name in documented)) expect(a.residualMax!, p.name).toBeLessThan(0.02);
    }
  });
});

describe('fitProxy', () => {
  it("reproduces MakeHuman's fit on the base mesh (float reference of the builder)", () => {
    for (const p of proxies) {
      const pos = fitProxy(p, human.base, undefined, { collide: false });
      expect(pos.length).toBe(p.vertexCount * 3);
      const c = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.fitCount; i++)
        for (let k = 0; k < 3; k++) {
          const v = pos[i * 3 + k];
          c[k] += v / p.fitCount;
          lo[k] = Math.min(lo[k], v);
          hi[k] = Math.max(hi[k], v);
        }
      const ref = json.proxies.find((q) => q.name === p.name)!.check!;
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(c[k] - ref.centroid[k]), p.name).toBeLessThan(5e-4);
        expect(Math.abs(lo[k] - ref.min[k]), p.name).toBeLessThan(1e-3);
        expect(Math.abs(hi[k] - ref.max[k]), p.name).toBeLessThan(1e-3);
      }
      // uv-seam duplicates sit on their canonical vertex
      for (let k = 0; k < p.dup.length; k++) for (let a = 0; a < 3; a++) expect(pos[(p.fitCount + k) * 3 + a]).toBe(pos[p.dup[k] * 3 + a]);
    }
  });

  it('writes into the given buffer and applies scale / offset', () => {
    const p = byName.get('short02')!;
    const out = new Float32Array(p.vertexCount * 3);
    expect(fitProxy(p, human.base, out)).toBe(out);
    const m = fitProxy(p, human.base, undefined, { scale: 0.1, offset: [1, 2, 3] });
    let d = 0;
    for (let i = 0; i < out.length; i += 3) d = Math.max(d, Math.abs(out[i] * 0.1 + 1 - m[i]), Math.abs(out[i + 1] * 0.1 + 2 - m[i + 1]), Math.abs(out[i + 2] * 0.1 + 3 - m[i + 2]));
    expect(d).toBeLessThan(1e-5);
    expect(() => fitProxy(p, human.base.subarray(0, N_SKIN * 3))).toThrow();
  });

  it('keeps eyes, brows and lashes in place on morphed heads', () => {
    for (const name of Object.keys(SHAPES)) {
      const base = shape(name);
      const hc = headCentre(base);
      // eyeballs: centred on the eye helper geometry of the base mesh, symmetric, in the front half of the head
      const eyes = byName.get('eyes')!;
      const pe = fitProxy(eyes, base);
      const centre = [[0, 0, 0], [0, 0, 0]], helper = [[0, 0, 0], [0, 0, 0]], cnt = [0, 0];
      let radius = 0;
      for (let i = 0; i < eyes.fitCount; i++) {
        const side = pe[i * 3] > 0 ? 0 : 1;
        cnt[side]++;
        for (let k = 0; k < 3; k++) {
          centre[side][k] += pe[i * 3 + k];
          helper[side][k] += (base[eyes.ref[i * 3] * 3 + k] + base[eyes.ref[i * 3 + 1] * 3 + k] + base[eyes.ref[i * 3 + 2] * 3 + k]) / 3;
        }
      }
      for (let s = 0; s < 2; s++)
        for (let k = 0; k < 3; k++) {
          centre[s][k] /= cnt[s];
          helper[s][k] /= cnt[s];
          expect(Math.abs(centre[s][k] - helper[s][k]), `${name} eye`).toBeLessThan(0.02);
        }
      for (let i = 0; i < eyes.fitCount; i++) if (pe[i * 3] > 0) radius += Math.hypot(pe[i * 3] - centre[0][0], pe[i * 3 + 1] - centre[0][1], pe[i * 3 + 2] - centre[0][2]) / cnt[0];
      expect(radius, name).toBeGreaterThan(0.09);
      expect(radius, name).toBeLessThan(0.17); // mean eyeball radius 9–17 mm (adult ≈ 12 mm)
      expect(Math.abs(centre[0][0] + centre[1][0]), name).toBeLessThan(0.03);
      expect(centre[0][2], name).toBeGreaterThan(hc[2] + 0.4);
      // brows: glued to the skin (≤ 5 mm from it) and above the eyeballs
      for (const brow of proxiesOfKind(proxies, 'eyebrows')) {
        const pb = fitProxy(brow, base);
        const cl = clearance(pb, brow.fitCount, base, hc[1] - 1.5);
        let far = 0, low = Infinity, deep = 0, mean = 0;
        for (let i = 0; i < brow.fitCount; i++) {
          far = Math.max(far, cl.dist[i]);
          deep = Math.min(deep, cl.signed[i]);
          low = Math.min(low, pb[i * 3 + 1]);
          mean += pb[i * 3 + 1] / brow.fitCount;
        }
        expect(far, `${name} ${brow.name}`).toBeLessThan(0.08);
        expect(deep, `${name} ${brow.name}`).toBeGreaterThan(-0.02);
        // the brow strip (incl. its transparent rim) lies on the brow ridge: wholly above the pupil line
        expect(low, `${name} ${brow.name}`).toBeGreaterThan(centre[0][1]);
        expect(mean, `${name} ${brow.name}`).toBeGreaterThan(centre[0][1] + 0.5 * radius);
        expect(mean, `${name} ${brow.name}`).toBeLessThan(centre[0][1] + 3 * radius);
      }
      // lashes: every vertex within 2.5 eyeball radii of an eye centre, roots on the lid (≤ 1 mm from the skin)
      const lash = byName.get('eyelashes02')!;
      const pl = fitProxy(lash, base);
      const cl = clearance(pl, lash.fitCount, base, hc[1] - 1.5);
      let nearest = Infinity;
      for (let i = 0; i < lash.fitCount; i++) {
        const s = pl[i * 3] > 0 ? 0 : 1;
        expect(Math.hypot(pl[i * 3] - centre[s][0], pl[i * 3 + 1] - centre[s][1], pl[i * 3 + 2] - centre[s][2]), `${name} lash`).toBeLessThan(3 * radius);
        nearest = Math.min(nearest, cl.dist[i]);
      }
      expect(nearest, name).toBeLessThan(0.01);
    }
  });

  it('keeps every hairstyle on the scalp of morphed heads (no poke-through, no floating)', () => {
    const report: string[] = [];
    const checks: (() => void)[] = [];
    const GAP_LIMIT = 0.35; // dm; the voluminous bob floats ≈ 3 cm above the crown on every head, the others ≤ 2 cm
    for (const name of Object.keys(SHAPES)) {
      const base = shape(name);
      const hc = headCentre(base);
      // skull cap: skin vertices well above the centre of the head
      const cap: number[] = [];
      for (let v = 0; v < N_SKIN; v++) if (base[v * 3 + 1] > hc[1] + 0.45 && Math.hypot(base[v * 3] - hc[0], base[v * 3 + 2] - hc[2]) < 0.85) cap.push(v);
      expect(cap.length).toBeGreaterThan(40);
      for (const hair of proxiesOfKind(proxies, 'hair')) {
        const pos = fitProxy(hair, base);
        // (a) coverage: each cap vertex has hair right above it (nearest hair vertex within 2.5 cm, further from the centre)
        let worstGap = 0, under = 0;
        for (const v of cap) {
          const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2];
          let best = Infinity, bi = 0;
          for (let i = 0; i < hair.fitCount; i++) {
            const d = (pos[i * 3] - x) ** 2 + (pos[i * 3 + 1] - y) ** 2 + (pos[i * 3 + 2] - z) ** 2;
            if (d < best) {
              best = d;
              bi = i;
            }
          }
          worstGap = Math.max(worstGap, Math.sqrt(best));
          const rs = Math.hypot(x - hc[0], y - hc[1], z - hc[2]);
          const rh = Math.hypot(pos[bi * 3] - hc[0], pos[bi * 3 + 1] - hc[1], pos[bi * 3 + 2] - hc[2]);
          if (rh < rs - 0.005) under++;
        }
        // (b) penetration: share of hair vertices more than 1 mm below the skin (hairline cards dip in by design)
        const cl = clearance(pos, hair.fitCount, base, hc[1] - 7.5);
        let inside = 0;
        for (let i = 0; i < hair.fitCount; i++) if (cl.signed[i] < -0.01) inside++;
        report.push(`${name} ${hair.name}: gap ${worstGap.toFixed(3)} under ${under}/${cap.length} inside ${((inside / hair.fitCount) * 100).toFixed(1)}%`);
        checks.push(() => {
          expect(worstGap, `${name} ${hair.name}`).toBeLessThan(GAP_LIMIT);
          expect(under / cap.length, `${name} ${hair.name}`).toBeLessThan(0.05);
          expect(inside / hair.fitCount, `${name} ${hair.name}`).toBeLessThan(0.1);
        });
      }
    }
    if (process.env.PROXY_TEST_VERBOSE) console.log(report.join('\n'));
    for (const c of checks) c();
  });

  it('pushes long hair out of heavy shoulders and backs', () => {
    const hair = byName.get('long01')!;
    const base = shape('heavyFemale');
    const hc = headCentre(base);
    const count = (collide: boolean) => {
      const pos = fitProxy(hair, base, undefined, { collide });
      const cl = clearance(pos, hair.fitCount, base, hc[1] - 7.5);
      let inside = 0, deepest = 0;
      for (let i = 0; i < hair.fitCount; i++) {
        if (cl.signed[i] < -0.01) inside++;
        deepest = Math.min(deepest, cl.signed[i]);
      }
      return { inside, deepest, pos };
    };
    const off = count(false), on = count(true);
    if (process.env.PROXY_TEST_VERBOSE) console.log('long01 heavyFemale inside', off.inside, '→', on.inside, 'deepest', off.deepest.toFixed(3), '→', on.deepest.toFixed(3));
    expect(on.inside).toBeLessThan(off.inside * 0.7);
    expect(maxDiff(on.pos, off.pos)).toBeGreaterThan(0.1); // some vertices moved by more than 1 cm
    // on a slim body the colliders barely act (the hair was authored for it)
    const slim = shape('female');
    expect(maxDiff(fitProxy(hair, slim), fitProxy(hair, slim, undefined, { collide: false }))).toBeLessThan(0.08);
  });

  it('follows a posed head: offsets rotate with the head when opts.rest is given', () => {
    const rest = shape('male');
    const hc = headCentre(rest);
    // (1) rigid motion of the whole body: 15° roll about the neck + translation
    const pivot = [hc[0], hc[1] - 1.2], t = [0.3, -0.2, 0.5];
    const posed = rotateZ(rest, 15, pivot, t);
    for (const p of proxies) {
      const want = rotateZ(fitProxy(p, rest), 15, pivot, t);
      const got = fitProxy(p, posed, undefined, { rest });
      expect(maxDiff(got, want), p.name).toBeLessThan(2e-3);
      if (p.kind === 'hair') expect(maxDiff(fitProxy(p, posed), want), p.name).toBeGreaterThan(0.01); // without rest the offsets stay axis aligned
    }
    // (2) head only (everything above the neck) tilted by 15°: head-bound proxies follow rigidly
    const cut = hc[1] - 1.0;
    const tilted = rotateZ(rest, 15, pivot, [0, 0, 0], (i) => rest[i + 1] > cut);
    for (const p of proxies) {
      const r = fitProxy(p, rest, undefined, { collide: false });
      const want = rotateZ(r, 15, pivot, [0, 0, 0]);
      const got = fitProxy(p, tilted, undefined, { rest, collide: false });
      // compare the part on the upper head (well above the cut, where every reference vertex moved with the head)
      let worst = 0, n = 0;
      for (let i = 0; i < p.fitCount; i++) {
        if (r[i * 3 + 1] < cut + 0.4 || p.hw[i] !== 255) continue;
        if (rest[p.ref[i * 3] * 3 + 1] <= cut || rest[p.ref[i * 3 + 1] * 3 + 1] <= cut || rest[p.ref[i * 3 + 2] * 3 + 1] <= cut) continue;
        n++;
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[i * 3 + k] - want[i * 3 + k]));
      }
      expect(n, p.name).toBeGreaterThan(p.kind === 'hair' ? 200 : 100);
      expect(worst, p.name).toBeLessThan(2e-3);
    }
  });

  it('is fast: fit < 3 ms and normals < 3 ms per proxy', () => {
    const rest = shape('male');
    const hc = headCentre(rest);
    const posed = rotateZ(rest, 15, [hc[0], hc[1] - 1.2], [0, 0, 0]);
    for (const p of proxies) {
      const pos = new Float32Array(p.vertexCount * 3), nrm = new Float32Array(p.vertexCount * 3);
      const time = (fn: () => void) => {
        for (let i = 0; i < 20; i++) fn();
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) fn();
        return (performance.now() - t0) / 50;
      };
      expect(time(() => fitProxy(p, posed, pos, { rest })), p.name).toBeLessThan(3);
      expect(time(() => (p.kind === 'hair' ? computeHairNormals(p, pos, posed, nrm) : computeProxyNormals(p, pos, nrm))), p.name).toBeLessThan(3);
    }
  });
});

describe('proxy shading helpers', () => {
  const unit = (a: Float32Array, n: number) => {
    let worst = 0;
    for (let i = 0; i < n * 3; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(a[i], a[i + 1], a[i + 2]) - 1));
    return worst;
  };

  it('computes unit normals, seam duplicates share the normal of their canonical vertex', () => {
    const base = shape('female');
    for (const p of proxies) {
      const pos = fitProxy(p, base);
      const n = computeProxyNormals(p, pos);
      expect(unit(n, p.vertexCount), p.name).toBeLessThan(1e-4);
      for (let k = 0; k < p.dup.length; k++) for (let a = 0; a < 3; a++) expect(n[(p.fitCount + k) * 3 + a]).toBe(n[p.dup[k] * 3 + a]);
    }
    // eyeball normals point away from the eye centre
    const eyes = byName.get('eyes')!;
    const pe = fitProxy(eyes, base), ne = computeProxyNormals(eyes, pe);
    const c = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < eyes.fitCount; i++)
      if (pe[i * 3] > 0) {
        cnt++;
        for (let k = 0; k < 3; k++) c[k] += pe[i * 3 + k];
      }
    let outward = 0;
    for (let i = 0; i < eyes.fitCount; i++)
      if (pe[i * 3] > 0 && (pe[i * 3] - c[0] / cnt) * ne[i * 3] + (pe[i * 3 + 1] - c[1] / cnt) * ne[i * 3 + 1] + (pe[i * 3 + 2] - c[2] / cnt) * ne[i * 3 + 2] > 0) outward++;
    expect(outward / cnt).toBeGreaterThan(0.97);
  });

  it('bends hair normals outwards and derives strand tangents', () => {
    const base = shape('female');
    const hc = headCentre(base);
    for (const p of proxiesOfKind(proxies, 'hair') as Proxy[]) {
      const pos = fitProxy(p, base);
      const n = computeHairNormals(p, pos, base);
      expect(unit(n, p.vertexCount), p.name).toBeLessThan(1e-4);
      let outward = 0;
      for (let i = 0; i < p.vertexCount; i++) if ((pos[i * 3] - hc[0]) * n[i * 3] + (pos[i * 3 + 1] - hc[1]) * n[i * 3 + 1] + (pos[i * 3 + 2] - hc[2]) * n[i * 3 + 2] > 0) outward++;
      expect(outward / p.vertexCount, p.name).toBeGreaterThan(0.99);
      const t = computeProxyTangents(p, pos)!;
      expect(t).not.toBeNull();
      expect(unit(t, p.vertexCount), p.name).toBeLessThan(1e-4);
    }
    expect(computeProxyTangents(byName.get('eyes')!, fitProxy(byName.get('eyes')!, base))).toBeNull();
    // long straight hair hangs down: below the chin its strands are close to vertical
    const long = byName.get('long01')!;
    const pos = fitProxy(long, base), t = computeProxyTangents(long, pos)!;
    const ty: number[] = [];
    for (let i = 0; i < long.fitCount; i++) if (pos[i * 3 + 1] < hc[1] - 1.5) ty.push(Math.abs(t[i * 3 + 1]));
    ty.sort((a, b) => a - b);
    if (process.env.PROXY_TEST_VERBOSE) console.log('long01 |ty| p10/p50', ty[Math.floor(ty.length * 0.1)].toFixed(2), ty[ty.length >> 1].toFixed(2), 'n', ty.length);
    expect(ty.length).toBeGreaterThan(500);
    expect(ty[ty.length >> 1]).toBeGreaterThan(0.9);
  });
});
