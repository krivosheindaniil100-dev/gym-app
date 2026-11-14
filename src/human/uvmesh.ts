/**
 * Skin UVs for the Catmull–Clark-subdivided body ("skin-uv" track).
 *
 * Assets (built by tools/mh/build_skin.py):
 *   uv.bin  – [vt table: uint16 (u, v) per unique UV, value / 65535]
 *             [corner table: uint16 × 4 per body quad → index into the vt table; SAME face order and SAME corner
 *              order as human.json layout.faces.body, i.e. as HumanData.faces.body]
 *   uv.json – { layout: { vt: [byteOffset, count], corners: [byteOffset, faceCount] }, textures, wear, ao, … }
 *
 * Conventions
 *   - UVs are OpenGL/OBJ style (origin bottom-left, v UP) → three.js textures with the default flipY = true
 *     (THREE.TextureLoader). With ImageBitmapLoader pass { imageOrientation: 'flipY' }.
 *   - The render mesh is the once-subdivided body of engine.ts (buildSubdiv / subdivide) split along UV seams:
 *     render vertices [0, nSubdiv) ARE the subdivided vertices (same index, order = [original verts][edge points]
 *     [face points]); render vertices [nSubdiv, count) are UV-seam duplicates. `renderToSubdiv` maps every render
 *     vertex to its subdivided vertex, `indices` lists the triangles in exactly the order of SubdivTopo.outTris
 *     (renderToSubdiv[indices[i]] === outTris[i]).
 *   - UVs of the subdivided corners are interpolated linearly inside each base quad (corner, edge midpoint,
 *     centroid) – the usual "linear face-varying" rule, so the painted texture is not swum by the smoothing.
 *
 * Worker usage per morph:
 *   const sub = subdivide(topo, pos, xf);                 // (nV+nE+nF) × 3
 *   const nrm = computeNormals(sub, topo.outTris);         // smooth normals on the UNSPLIT mesh → no seam crease
 *   expand(sub, render.renderToSubdiv, outPos);            // render.count × 3
 *   expand(nrm, render.renderToSubdiv, outNrm);
 * Pure typed-array code: works in a Web Worker, no DOM / WebGL.
 */
import type { SubdivTopo } from './engine';

export interface SkinTextureInfo {
  /** file name relative to the asset base url, e.g. "tex/skin_caucasian_male.webp" */
  file: string;
  size: number;
  /** area-weighted mean albedo of the skin (body UV islands, without lips / nipples / scalp stubble), sRGB 0..1 */
  meanSrgb: [number, number, number];
  /** the same mean in linear-sRGB (mean of linearised texels) */
  meanLinear: [number, number, number];
}

export interface UvMeta {
  layout: { vt: [number, number]; corners: [number, number] };
  convention?: string;
  /** skin albedo textures keyed "<ethnicity>_<sex>", e.g. "caucasian_male" */
  textures?: Record<string, SkinTextureInfo>;
  /** sportswear masks keyed by sex: R fabric coverage, G elastic bands, B seam / wrinkle shading */
  wear?: Record<string, { file: string; size: number; channels: Record<string, string>; smoothVerts?: number[] }>;
  ao?: { file: string; size: number };
  retone?: Record<string, unknown>;
}

export interface UvData {
  /** unique UVs, 2 floats per entry, v up */
  vt: Float32Array;
  /** 4 vt indices per body quad (same order as HumanData.faces.body) */
  corners: Uint16Array;
  meta: UvMeta;
}

export interface RenderTopo {
  /** number of subdivided vertices = nV + nE + nF; render vertices [0, nSubdiv) are identical to them */
  nSubdiv: number;
  /** number of render vertices = nSubdiv + UV-seam duplicates */
  count: number;
  /** render vertex → subdivided vertex (identity for the first nSubdiv entries) */
  renderToSubdiv: Uint32Array;
  /** 2 floats per render vertex, v up */
  uv: Float32Array;
  /** triangles (render vertex indices), same order and winding as SubdivTopo.outTris */
  indices: Uint32Array;
}

/** Decode uv.bin (the buffer is not retained: the returned arrays are copies / decoded). */
export function parseUvData(meta: UvMeta, buf: ArrayBuffer): UvData {
  const [vOff, nVt] = meta.layout.vt;
  const [cOff, nFaces] = meta.layout.corners;
  const q = new Uint16Array(buf, vOff, nVt * 2);
  const vt = new Float32Array(nVt * 2);
  for (let i = 0; i < vt.length; i++) vt[i] = q[i] / 65535;
  const corners = new Uint16Array(buf.slice(cOff, cOff + nFaces * 8));
  return { vt, corners, meta };
}

export async function loadUvData(baseUrl: string): Promise<UvData> {
  const [metaRes, binRes] = await Promise.all([fetch(baseUrl + 'uv.json'), fetch(baseUrl + 'uv.bin')]);
  if (!metaRes.ok || !binRes.ok) throw new Error('uv asset not found');
  return parseUvData((await metaRes.json()) as UvMeta, await binRes.arrayBuffer());
}

/**
 * Static render topology of the once-subdivided group `t` (the body) split along UV seams.
 * `t` must be buildSubdiv(HumanData.faces.body) so that face f of `t` is face f of the corner table.
 * One-off cost ≈ 10 ms for the body (13378 quads → 53 512 sub-quads, 107 024 triangles).
 */
export function buildRenderTopo(t: SubdivTopo, uv: UvData): RenderTopo {
  const { nV, nE, nF, quads, faceEdges } = t;
  const { vt, corners } = uv;
  if (corners.length !== nF * 4) throw new Error(`uv corner table has ${corners.length / 4} faces, topology has ${nF}`);
  const nSubdiv = nV + nE + nF;
  const EOFF = nV;
  const FOFF = nV + nE;
  // per subdivided vertex: key of its canonical uv (−1 = not seen yet); duplicates are chained through `next`
  const key0 = new Float64Array(nSubdiv).fill(-1);
  const head = new Int32Array(nSubdiv).fill(-1); // first duplicate (index into dup arrays)
  const dupSub: number[] = [];
  const dupKey: number[] = [];
  const dupNext: number[] = [];
  const dupU: number[] = [];
  const dupV: number[] = [];
  const uvOut = new Float32Array(nSubdiv * 2);

  const lookup = (s: number, key: number, u: number, v: number): number => {
    const k0 = key0[s];
    if (k0 === key) return s;
    if (k0 === -1) {
      key0[s] = key;
      uvOut[s * 2] = u;
      uvOut[s * 2 + 1] = v;
      return s;
    }
    for (let d = head[s]; d !== -1; d = dupNext[d]) if (dupKey[d] === key) return nSubdiv + d;
    const d = dupSub.length;
    dupSub.push(s);
    dupKey.push(key);
    dupNext.push(head[s]);
    dupU.push(u);
    dupV.push(v);
    head[s] = d;
    return nSubdiv + d;
  };

  const indices = new Uint32Array(nF * 24);
  const c = [0, 0, 0, 0]; // vt index per corner
  const rc = [0, 0, 0, 0]; // render vertex per corner
  const re = [0, 0, 0, 0]; // render vertex per face side k (edge between corner k and k+1)
  for (let f = 0; f < nF; f++) {
    const f4 = f * 4;
    let cu = 0;
    let cv = 0;
    for (let k = 0; k < 4; k++) {
      const i = corners[f4 + k];
      c[k] = i;
      cu += vt[i * 2];
      cv += vt[i * 2 + 1];
      rc[k] = lookup(quads[f4 + k], i, vt[i * 2], vt[i * 2 + 1]);
    }
    for (let k = 0; k < 4; k++) {
      // same end-vertex choice as engine.ts buildSubdiv (triangles stored as degenerate quads)
      let k1 = (k + 1) & 3;
      if (quads[f4 + k] === quads[f4 + k1]) k1 = (k + 2) & 3;
      const a = c[k];
      const b = c[k1];
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      re[k] = lookup(EOFF + faceEdges[f4 + k], key, (vt[a * 2] + vt[b * 2]) * 0.5, (vt[a * 2 + 1] + vt[b * 2 + 1]) * 0.5);
    }
    const fc = lookup(FOFF + f, 0, cu * 0.25, cv * 0.25);
    for (let k = 0; k < 4; k++) {
      const o = f * 24 + k * 6;
      const d = re[(k + 3) & 3];
      indices[o] = rc[k];
      indices[o + 1] = re[k];
      indices[o + 2] = fc;
      indices[o + 3] = rc[k];
      indices[o + 4] = fc;
      indices[o + 5] = d;
    }
  }
  const nDup = dupSub.length;
  const count = nSubdiv + nDup;
  const renderToSubdiv = new Uint32Array(count);
  const uvAll = new Float32Array(count * 2);
  uvAll.set(uvOut);
  for (let i = 0; i < nSubdiv; i++) renderToSubdiv[i] = i;
  for (let d = 0; d < nDup; d++) {
    renderToSubdiv[nSubdiv + d] = dupSub[d];
    uvAll[(nSubdiv + d) * 2] = dupU[d];
    uvAll[(nSubdiv + d) * 2 + 1] = dupV[d];
  }
  return { nSubdiv, count, renderToSubdiv, uv: uvAll, indices };
}

/**
 * out[i] = src[map[i]] for `itemSize`-component attributes (positions, normals, …).
 * REQUIRES the layout produced by buildRenderTopo: map[i] === i for i < src.length / itemSize, so the first block is
 * a plain memcpy and only the seam duplicates are gathered (≈ 0.05 ms for the body).
 * `out` must hold map.length × itemSize floats; returns `out`.
 */
export function expand(src: Float32Array, map: Uint32Array, out: Float32Array, itemSize = 3): Float32Array {
  out.set(src);
  const n0 = (src.length / itemSize) | 0;
  const n = map.length;
  if (itemSize === 3) {
    for (let i = n0, o = n0 * 3; i < n; i++, o += 3) {
      const s = map[i] * 3;
      out[o] = src[s];
      out[o + 1] = src[s + 1];
      out[o + 2] = src[s + 2];
    }
  } else {
    for (let i = n0; i < n; i++) {
      const s = map[i] * itemSize;
      const o = i * itemSize;
      for (let k = 0; k < itemSize; k++) out[o + k] = src[s + k];
    }
  }
  return out;
}

// ───────────────────────── skin tone helpers ─────────────────────────
// Re-toning (fragment shader, LINEAR space, after the sRGB albedo has been decoded):
//     albedo' = target * pow(albedo / meanLinear, k)  =  pow(albedo, k) * retoneGain(meanLinear, target, k)
// k = 1 is a plain per-channel gain (keeps every painted detail, the texture mean lands exactly on `target`);
// k < 1 flattens the painted contrast (use ≈ 0.85 when a light texture is darkened a lot).

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Per-channel factor g so that albedo' = pow(albedo, k) * g maps the texture mean onto `targetLinear`. */
export function retoneGain(meanLinear: ArrayLike<number>, targetLinear: ArrayLike<number>, k = 1): [number, number, number] {
  return [0, 1, 2].map((i) => targetLinear[i] / Math.pow(Math.max(meanLinear[i], 1e-4), k)) as [number, number, number];
}

/**
 * Key of the skin texture to use for a wanted tone (linear RGB). Darkening a light texture works well even by 6×,
 * lightening a dark one by more than ≈ 1.3× does not (its painted highlights and black stubble turn grey), so the
 * cost of a texture is |ln(texture luminance / target luminance)|, × 4 when the texture would have to be lightened.
 * `preferred` (e.g. the texture of the user's ethnicity) wins while its cost is ≤ 1; otherwise the cheapest texture
 * of that sex is returned (any sex if there is none).
 */
export function pickSkinTexture(meta: UvMeta, sex: 'male' | 'female', targetLinear: ArrayLike<number>, preferred?: string): string | null {
  const lum = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const tex = meta.textures ?? {};
  const keys = Object.keys(tex);
  const own = keys.filter((k) => k.endsWith('_' + sex));
  const pool = own.length ? own : keys;
  const lt = Math.log(Math.max(lum(targetLinear), 1e-4));
  const cost = (k: string) => {
    const d = Math.log(Math.max(lum(tex[k].meanLinear), 1e-4)) - lt;
    return d >= 0 ? d : -4 * d;
  };
  if (preferred && tex[preferred] && cost(preferred) <= 1) return preferred;
  let best: string | null = null;
  let bestC = Infinity;
  for (const k of pool) {
    const c = cost(k);
    if (c < bestC) {
      bestC = c;
      best = k;
    }
  }
  return best;
}

// ───────────────────────── sportswear helpers ─────────────────────────
// Mask texture (uv.json wear.<sex>, lossless WebP, LINEAR data: texture.colorSpace = NoColorSpace, flipY = true):
//   R  fabric coverage as a ±1.5-texel distance ramp, 0.5 = garment edge
//   G  elastic bands (waistband / under-bust band 1.0, hems and bindings 0.6)
//   B  shading, 0.5 neutral (seams, stitch lines, folds; soft contact shadow on the skin next to the fabric)
// Fragment shader (after the albedo / re-toning):
//   vec3 wear = texture2D(wearMap, vUv).rgb;
//   float w = clamp(fwidth(wear.r), 0.02, 0.5);
//   float cover = smoothstep(0.5 - w, 0.5 + w, wear.r);            // crisp at any zoom, plain coverage when minified
//   vec3 cloth = mix(fabricColor, bandColor, wear.g);
//   diffuseColor.rgb = mix(diffuseColor.rgb, cloth, cover) * (0.5 + wear.b);
//   roughness = mix(roughness, 0.9, cover);   // and switch off skin-only effects (SSS tint, pores, sweat) by cover

export interface RelaxSet {
  /** GLOBAL base-vertex indices to relax */
  verts: Uint32Array;
  /** CSR edge neighbours (GLOBAL indices) of every vertex in `verts` */
  nbrPtr: Uint32Array;
  nbr: Uint32Array;
  tmp: Float32Array;
}

/**
 * Prepares relaxVerts() for a list of GLOBAL base vertices (e.g. uv.json wear.female.smoothVerts = both nipples,
 * which would otherwise poke through the painted-on top). `t` = buildSubdiv(HumanData.faces.body).
 */
export function buildRelaxSet(t: SubdivTopo, verts: ArrayLike<number>): RelaxSet {
  const local = new Map<number, number>();
  for (let i = 0; i < t.nV; i++) local.set(t.verts[i], i);
  const ptr = new Uint32Array(verts.length + 1);
  const nbr: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i < verts.length; i++) {
    const l = local.get(verts[i]);
    if (l === undefined) continue;
    for (let j = t.vePtr[l]; j < t.vePtr[l + 1]; j++) {
      const e = t.ve[j];
      nbr.push(t.verts[t.edges[e * 2] === l ? t.edges[e * 2 + 1] : t.edges[e * 2]]);
    }
    kept.push(verts[i]);
    ptr[kept.length] = nbr.length;
  }
  return { verts: Uint32Array.from(kept), nbrPtr: ptr.slice(0, kept.length + 1), nbr: Uint32Array.from(nbr), tmp: new Float32Array(kept.length * 3) };
}

/**
 * Laplacian (Jacobi) relaxation of the set's vertices in the global base position array `pos` (all base vertices × 3,
 * any unit), in place, everything else fixed. Call after the morph targets and before subdivide(). ≈ 0.02 ms.
 */
export function relaxVerts(pos: Float32Array, set: RelaxSet, iterations = 10): void {
  const { verts, nbrPtr, nbr, tmp } = set;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < verts.length; i++) {
      let x = 0;
      let y = 0;
      let z = 0;
      const a = nbrPtr[i];
      const b = nbrPtr[i + 1];
      for (let j = a; j < b; j++) {
        const o = nbr[j] * 3;
        x += pos[o];
        y += pos[o + 1];
        z += pos[o + 2];
      }
      const n = b - a || 1;
      tmp[i * 3] = x / n;
      tmp[i * 3 + 1] = y / n;
      tmp[i * 3 + 2] = z / n;
    }
    for (let i = 0; i < verts.length; i++) {
      const o = verts[i] * 3;
      pos[o] = tmp[i * 3];
      pos[o + 1] = tmp[i * 3 + 1];
      pos[o + 2] = tmp[i * 3 + 2];
    }
  }
}
