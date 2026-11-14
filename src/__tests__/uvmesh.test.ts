import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSubdiv, computeNormals, subdivide } from '../human/engine';
import { buildRelaxSet, buildRenderTopo, expand, parseUvData, pickSkinTexture, relaxVerts, retoneGain, srgbToLinear, type UvMeta } from '../human/uvmesh';

const DIR = join(__dirname, '..', '..', 'public', 'human');

function ab(name: string): ArrayBuffer {
  const b = readFileSync(join(DIR, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function loadAll() {
  const hm = JSON.parse(readFileSync(join(DIR, 'human.json'), 'utf8'));
  const hb = ab('human.bin');
  const [pOff, nVerts] = hm.layout.positions as [number, number];
  const base = new Float32Array(hb, pOff, nVerts * 3);
  const [fOff, nFaces] = hm.layout.faces.body as [number, number];
  const body = new Uint16Array(hb, fOff, nFaces * 4);
  const meta = JSON.parse(readFileSync(join(DIR, 'uv.json'), 'utf8')) as UvMeta;
  const uv = parseUvData(meta, ab('uv.bin'));
  return { base, body, uv, meta };
}

const ident = (x: number, y: number, z: number, o: Float32Array, i: number) => {
  o[i] = x;
  o[i + 1] = y;
  o[i + 2] = z;
};

/** signed area of the UV triangle (a, b, c) given indices into a uv array */
function triArea(uv: Float32Array, a: number, b: number, c: number): number {
  return 0.5 * ((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1]));
}

describe('uvmesh (skin UVs on the subdivided body)', () => {
  const { base, body, uv, meta } = loadAll();
  const topo = buildSubdiv(body);
  const render = buildRenderTopo(topo, uv);
  const sub = subdivide(topo, base, ident);

  it('uv.bin matches the body faces of human.bin', () => {
    expect(uv.corners.length).toBe(body.length);
    expect(uv.vt.length / 2).toBe(meta.layout.vt[1]);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of uv.vt) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    // every vt belongs to exactly one mesh vertex – a scrambled face/corner order would break this
    const owner = new Int32Array(uv.vt.length / 2).fill(-1);
    let conflicts = 0;
    for (let i = 0; i < body.length; i++) {
      const t = uv.corners[i];
      if (owner[t] === -1) owner[t] = body[i];
      else if (owner[t] !== body[i]) conflicts++;
    }
    expect(conflicts).toBe(0);
    expect(owner.every((o) => o >= 0)).toBe(true);
    // the two UV edges of every interior mesh edge have the same length unless the edge is a seam: most are not
    const seamVerts = uv.vt.length / 2 - topo.nV;
    expect(seamVerts).toBeGreaterThan(500);
    expect(seamVerts).toBeLessThan(2500);
  });

  it('render topology: counts, identity prefix, triangles in outTris order', () => {
    const { nV, nE, nF } = topo;
    expect(render.nSubdiv).toBe(nV + nE + nF);
    expect(render.indices.length).toBe(nF * 24);
    expect(render.indices.length).toBe(topo.outTris.length);
    expect(render.renderToSubdiv.length).toBe(render.count);
    expect(render.uv.length).toBe(render.count * 2);
    expect(render.count).toBeGreaterThan(render.nSubdiv);
    expect(render.count).toBeLessThan(render.nSubdiv * 1.08);
    let bad = 0;
    for (let i = 0; i < render.nSubdiv; i++) if (render.renderToSubdiv[i] !== i) bad++;
    for (let i = 0; i < render.indices.length; i++) if (render.renderToSubdiv[render.indices[i]] !== topo.outTris[i]) bad++;
    expect(bad).toBe(0);
    // every render vertex is referenced
    const used = new Uint8Array(render.count);
    for (const i of render.indices) used[i] = 1;
    expect(used.every((u) => u === 1)).toBe(true);
  });

  it('render vertices are exactly the unique (subdivided vertex, uv) pairs', () => {
    // brute force with float UVs computed independently per sub-quad corner
    const { nV, nE, nF, quads, faceEdges } = topo;
    const pairs = new Set<string>();
    const cu = [0, 0, 0, 0];
    const cv = [0, 0, 0, 0];
    let mismatch = 0;
    const eps = 1e-6;
    for (let f = 0; f < nF; f++) {
      for (let k = 0; k < 4; k++) {
        cu[k] = uv.vt[uv.corners[f * 4 + k] * 2];
        cv[k] = uv.vt[uv.corners[f * 4 + k] * 2 + 1];
      }
      const fu = (cu[0] + cu[1] + cu[2] + cu[3]) / 4;
      const fv = (cv[0] + cv[1] + cv[2] + cv[3]) / 4;
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) & 3;
        const k3 = (k + 3) & 3;
        const sv = [quads[f * 4 + k], nV + faceEdges[f * 4 + k], nV + nE + f, nV + faceEdges[f * 4 + k3]];
        const su = [cu[k], (cu[k] + cu[k1]) / 2, fu, (cu[k3] + cu[k]) / 2];
        const svv = [cv[k], (cv[k] + cv[k1]) / 2, fv, (cv[k3] + cv[k]) / 2];
        // triangles (0,1,2) (0,2,3) of this sub-quad in the render index buffer
        const o = f * 24 + k * 6;
        const rv = [render.indices[o], render.indices[o + 1], render.indices[o + 2], render.indices[o + 5]];
        if (render.indices[o + 3] !== rv[0] || render.indices[o + 4] !== rv[2]) mismatch++;
        for (let j = 0; j < 4; j++) {
          pairs.add(`${sv[j]}:${Math.round(su[j] * 131070)}:${Math.round(svv[j] * 131070)}`);
          if (render.renderToSubdiv[rv[j]] !== sv[j]) mismatch++;
          if (Math.abs(render.uv[rv[j] * 2] - su[j]) > eps || Math.abs(render.uv[rv[j] * 2 + 1] - svv[j]) > eps) mismatch++;
        }
      }
    }
    expect(mismatch).toBe(0);
    expect(pairs.size).toBe(render.count);
  });

  it('no degenerate or flipped UV triangles, UV area conserved per base face', () => {
    const { nF } = topo;
    let degenerate = 0;
    let flipped = 0;
    let worst = 0;
    let total = 0;
    let totalBase = 0;
    for (let f = 0; f < nF; f++) {
      const c = uv.corners;
      // shoelace area of the base quad in UV space
      let qa = 0;
      for (let k = 0; k < 4; k++) {
        const a = c[f * 4 + k];
        const b = c[f * 4 + ((k + 1) & 3)];
        qa += uv.vt[a * 2] * uv.vt[b * 2 + 1] - uv.vt[b * 2] * uv.vt[a * 2 + 1];
      }
      qa *= 0.5;
      let sa = 0;
      for (let t = 0; t < 8; t++) {
        const o = f * 24 + t * 3;
        const a = triArea(render.uv, render.indices[o], render.indices[o + 1], render.indices[o + 2]);
        if (Math.abs(a) < 1e-10) degenerate++;
        else if (a * qa < 0) flipped++;
        sa += a;
      }
      worst = Math.max(worst, Math.abs(sa - qa));
      total += Math.abs(sa);
      totalBase += Math.abs(qa);
    }
    expect(degenerate).toBe(0);
    expect(flipped).toBe(0);
    expect(worst).toBeLessThan(1e-8);
    expect(Math.abs(total - totalBase)).toBeLessThan(1e-6);
    // the body islands cover a sensible part of the atlas
    expect(totalBase).toBeGreaterThan(0.3);
    expect(totalBase).toBeLessThan(1.0);
  });

  it('expand(): seam duplicates share positions and normals with their subdivided vertex', () => {
    const nrm = computeNormals(sub, topo.outTris);
    const pos = expand(sub, render.renderToSubdiv, new Float32Array(render.count * 3));
    const nr = expand(nrm, render.renderToSubdiv, new Float32Array(render.count * 3));
    let bad = 0;
    let sameUv = 0;
    for (let i = 0; i < render.count; i++) {
      const s = render.renderToSubdiv[i];
      for (let k = 0; k < 3; k++) {
        if (pos[i * 3 + k] !== sub[s * 3 + k]) bad++;
        if (nr[i * 3 + k] !== nrm[s * 3 + k]) bad++;
      }
      if (i >= render.nSubdiv && render.uv[i * 2] === render.uv[s * 2] && render.uv[i * 2 + 1] === render.uv[s * 2 + 1]) sameUv++;
    }
    expect(bad).toBe(0);
    expect(sameUv).toBe(0); // a duplicate always carries a different uv than its canonical vertex
    // 2-component attributes use the generic path
    const two = new Float32Array(render.nSubdiv * 2).map((_, i) => i);
    const out2 = expand(two, render.renderToSubdiv, new Float32Array(render.count * 2), 2);
    const last = render.count - 1;
    expect(out2[last * 2 + 1]).toBe(render.renderToSubdiv[last] * 2 + 1);
  });

  it('is fast: build < 150 ms, expand < 2 ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) buildRenderTopo(topo, uv);
    const build = (performance.now() - t0) / 3;
    const out = new Float32Array(render.count * 3);
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      expand(sub, render.renderToSubdiv, out);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = times[25];
    console.log(`uvmesh: verts ${render.nSubdiv} → ${render.count} render, tris ${render.indices.length / 3}, build ${build.toFixed(1)} ms, expand median ${median.toFixed(3)} ms`);
    expect(build).toBeLessThan(150);
    expect(median).toBeLessThan(2);
  });

  it('re-toning helpers: gain maps the texture mean onto the target, texture choice avoids lightening', () => {
    const tex = meta.textures!;
    const cm = tex.caucasian_male.meanLinear;
    const am = tex.african_male.meanLinear;
    const g = retoneGain(cm, am);
    for (let i = 0; i < 3; i++) expect(cm[i] * g[i]).toBeCloseTo(am[i], 6);
    const g2 = retoneGain(cm, am, 0.85);
    for (let i = 0; i < 3; i++) expect(Math.pow(cm[i], 0.85) * g2[i]).toBeCloseTo(am[i], 6);
    for (const t of Object.values(tex)) for (let i = 0; i < 3; i++) expect(srgbToLinear(t.meanSrgb[i])).toBeCloseTo(t.meanLinear[i], 3);
    expect(pickSkinTexture(meta, 'male', am)).toBe('african_male');
    expect(pickSkinTexture(meta, 'male', cm, 'caucasian_male')).toBe('caucasian_male');
    expect(pickSkinTexture(meta, 'female', tex.african_female.meanLinear)).toBe('african_female');
    // a tan tone between the two: darken the light texture rather than lighten the dark one
    const tan = [0.62, 0.43, 0.32].map(srgbToLinear);
    expect(pickSkinTexture(meta, 'male', tan)).not.toBe('african_male');
    expect(pickSkinTexture(meta, 'male', tan, 'african_male')).not.toBe('african_male');
    // the preferred texture is kept for moderate darkening
    expect(pickSkinTexture(meta, 'male', cm.map((x) => x * 0.6), 'asian_male')).toBe('asian_male');
  });

  it('relaxVerts flattens the nipples (wear.female.smoothVerts) and touches nothing else', () => {
    const verts = meta.wear!.female.smoothVerts!;
    expect(verts.length).toBeGreaterThan(40);
    expect(verts.length).toBeLessThan(300);
    const set = buildRelaxSet(topo, verts);
    expect(set.verts.length).toBe(verts.length);
    // umbrella (vertex − mean of its neighbours) summed over the set must shrink a lot
    const bump = (p: Float32Array) => {
      let s = 0;
      for (let i = 0; i < set.verts.length; i++) {
        const a = set.nbrPtr[i];
        const b = set.nbrPtr[i + 1];
        let d2 = 0;
        for (let k = 0; k < 3; k++) {
          let m = 0;
          for (let j = a; j < b; j++) m += p[set.nbr[j] * 3 + k];
          d2 += (p[set.verts[i] * 3 + k] - m / (b - a)) ** 2;
        }
        s += Math.sqrt(d2);
      }
      return s / set.verts.length;
    };
    const pos = Float32Array.from(base);
    // exaggerate the nipple like the female morphs do: push the set 0.1 dm forward (+z)
    for (const v of verts) pos[v * 3 + 2] += 0.1;
    const before = bump(pos);
    const ref = Float32Array.from(pos);
    const t0 = performance.now();
    relaxVerts(pos, set, 10);
    const ms = performance.now() - t0;
    expect(bump(pos)).toBeLessThan(before * 0.5);
    const inSet = new Set(verts);
    let moved = 0;
    let maxMove = 0;
    for (let v = 0; v < pos.length / 3; v++) {
      const d = Math.hypot(pos[v * 3] - ref[v * 3], pos[v * 3 + 1] - ref[v * 3 + 1], pos[v * 3 + 2] - ref[v * 3 + 2]);
      if (!inSet.has(v) && d > 0) moved++;
      maxMove = Math.max(maxMove, d);
    }
    expect(moved).toBe(0);
    expect(maxMove).toBeLessThan(0.3); // decimetres: a local fix, not a deformation of the breast
    expect(ms).toBeLessThan(2);
    // mirror symmetric vertex set
    const xs = verts.map((v) => base[v * 3]);
    expect(xs.filter((x) => x > 0).length).toBe(xs.filter((x) => x < 0).length);
  });

  it('texture assets listed in uv.json exist and stay within the 2.0 MB budget', () => {
    let bytes = 0;
    const files: string[] = [];
    for (const t of Object.values(meta.textures ?? {})) {
      files.push(t.file);
      for (const m of [t.meanSrgb, t.meanLinear]) {
        expect(m.length).toBe(3);
        for (const x of m) {
          expect(x).toBeGreaterThan(0.01);
          expect(x).toBeLessThan(1);
        }
      }
    }
    for (const w of Object.values(meta.wear ?? {})) files.push(w.file);
    if (meta.ao) files.push(meta.ao.file);
    for (const f of files) {
      expect(existsSync(join(DIR, f)), f).toBe(true);
      bytes += statSync(join(DIR, f)).size;
    }
    expect(Object.keys(meta.textures ?? {})).toEqual(expect.arrayContaining(['caucasian_male', 'caucasian_female']));
    expect(Object.keys(meta.wear ?? {})).toEqual(expect.arrayContaining(['male', 'female']));
    expect(bytes).toBeLessThan(2.0 * 1024 * 1024);
  });
});
