/// <reference lib="webworker" />
/**
 * Human geometry worker.
 *
 * Pipeline per body: composition → MakeHuman morph (rest A-pose, decimetres) → skeleton: joints from the morphed
 * mesh, auto arm/leg clearance, natural relaxed pose (linear blend skinning) → Catmull–Clark subdivision of the
 * skin → UV-seam split → hair / brows / lashes / eyes fitted on the posed head → metres with feet on y = 0.
 */
import { buildSubdiv, computeNormals, loadHumanData, macroWeights, RULER, subdivide, type HumanData, type SubdivTopo } from './engine';
import { fitHuman, GIRTH_LABEL, macroFor, type GirthKey, type HumanInput } from './fit';
import { faceUVs, fitFace } from './face';
import { computeCapsules, computeJoints, estimateAbduction, loadSkeleton, poseBones, skin, type Pose, type Skeleton, type SkeletonJson } from './skeleton';
import { computeHairNormals, computeProxyNormals, computeProxyTangents, fitProxy, loadProxies, type Proxy, type ProxiesJson, type ProxyKind, type ProxyRenderHints } from './proxies';
import { buildRelaxSet, buildRenderTopo, expand, parseUvData, relaxVerts, type RelaxSet, type RenderTopo, type UvData, type UvMeta } from './uvmesh';
import type { BodyInfo } from '../body/model';

/** Which optional parts to build. */
export interface Look {
  /** hair proxy name or null */
  hair: string | null;
  /** eyebrow proxy name */
  brows: string | null;
  /** 0 = rest A-pose … 1 = relaxed standing pose */
  pose?: number;
}

export interface PartMesh {
  positions: Float32Array;
  normals: Float32Array;
  tangents?: Float32Array;
}

export interface Girth {
  key: string;
  label: string;
  cm: number;
  ring: number[];
}

export interface ProxyInfo {
  name: string;
  kind: ProxyKind;
  label: string;
  tags: string[];
  indices: Uint16Array;
  uvs: Float32Array;
  texture: string | null;
  textures: Record<string, string>;
  tint: number[];
  render: ProxyRenderHints;
  hasDir: boolean;
}

export type HumanReq =
  | { type: 'init'; id: number; baseUrl: string; input: HumanInput; look: Look }
  | { type: 'morph'; id: number; channel: string; input: HumanInput; look: Look }
  | { type: 'faceFit'; id: number; baseUrl: string; input: HumanInput; ratios: number[] }
  | { type: 'faceUV'; id: number; landmarks: number[] };

export interface FrameMsg {
  type: 'frame';
  id: number;
  channel: string;
  body: PartMesh;
  /** active proxies by name (absent for the ghost channel) */
  proxies: Record<string, PartMesh>;
  /** n × 7 (ax ay az bx by bz r), metres */
  capsules: Float32Array;
  girths: Girth[];
  info: BodyInfo;
  /** metres */
  head: { eyeY: number; eyeZ: number; topY: number };
  heightM: number;
  ms: number;
}

export type HumanRes =
  | {
      type: 'ready';
      id: number;
      body: { indices: Uint32Array; uv: Float32Array; rest: Float32Array; renderToSubdiv: Uint32Array; nSubdiv: number };
      proxies: ProxyInfo[];
      skins: NonNullable<UvMeta['textures']>;
      wear: NonNullable<UvMeta['wear']>;
    }
  | FrameMsg
  | { type: 'faceFit'; id: number; mods: Record<string, number> }
  | { type: 'faceUV'; id: number; uv: Float32Array; w: Float32Array }
  | { type: 'error'; id: number; message: string };

const post = (msg: HumanRes, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

interface Assets {
  data: HumanData;
  skel: Skeleton;
  proxies: Proxy[];
  uv: UvData;
  topo: SubdivTopo;
  render: RenderTopo;
  relaxFemale: RelaxSet | null;
  restSub: Float32Array; // welded subdivided rest positions (dm)
  restNormals: Float32Array;
  bodyVerts: Uint32Array; // base vertex ids used by the skin
}

let assets: Assets | null = null;
let dataOnly: HumanData | null = null;
// scratch buffers
let jointsBuf: Float32Array;
let posedBuf: Float32Array;
let poseBuf: Pose | undefined;

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`не удалось загрузить ${url.split('/').pop()} (${r.status})`);
  return (await r.json()) as T;
}
async function fetchBin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`не удалось загрузить ${url.split('/').pop()} (${r.status})`);
  return r.arrayBuffer();
}

async function loadAssets(baseUrl: string): Promise<Assets> {
  const [data, skelJson, skelBin, proxJson, proxBin, uvMeta, uvBin] = await Promise.all([
    dataOnly ? Promise.resolve(dataOnly) : loadHumanData(baseUrl),
    fetchJson<SkeletonJson>(baseUrl + 'skeleton.json'),
    fetchBin(baseUrl + 'skeleton.bin'),
    fetchJson<ProxiesJson>(baseUrl + 'proxies.json'),
    fetchBin(baseUrl + 'proxies.bin'),
    fetchJson<UvMeta>(baseUrl + 'uv.json'),
    fetchBin(baseUrl + 'uv.bin'),
  ]);
  dataOnly = data;
  const skel = loadSkeleton(skelJson, skelBin);
  const proxies = loadProxies(proxJson, proxBin);
  const uv = parseUvData(uvMeta, uvBin);
  const topo = buildSubdiv(data.faces.body);
  const render = buildRenderTopo(topo, uv);
  const smooth = uv.meta.wear?.female?.smoothVerts;
  const relaxFemale = smooth?.length ? buildRelaxSet(topo, smooth) : null;
  const restSub = subdivide(topo, data.base, (x, y, z, o, i) => {
    o[i] = x;
    o[i + 1] = y;
    o[i + 2] = z;
  });
  const restNormals = computeNormals(restSub, topo.outTris);
  jointsBuf = new Float32Array(skel.nJoints * 3);
  posedBuf = new Float32Array(data.base.length);
  return { data, skel, proxies, uv, topo, render, relaxFemale, restSub, restNormals, bodyVerts: topo.verts };
}

function build(A: Assets, input: HumanInput, look: Look, channel: string, id: number): { msg: FrameMsg; transfer: Transferable[] } {
  const t0 = performance.now();
  const fit = fitHuman(A.data, input);
  const rest = fit.pos; // all base vertices, dm, A-pose
  // the sports top is painted on the skin: flatten the modelled nipples underneath it
  if (input.sex === 'female' && A.relaxFemale) relaxVerts(rest, A.relaxFemale, 10);

  // skeleton adapts to the morphed body; arms / legs open just enough not to intersect on heavy bodies
  const joints = computeJoints(A.skel, rest, jointsBuf);
  const t = look.pose ?? 1;
  const abd = t > 0 ? estimateAbduction(A.skel, rest, joints) : { armAbductionDeg: 0, legAbductionDeg: 0 };
  poseBuf = poseBones(A.skel, joints, { t, ...abd }, poseBuf);
  const posed = skin(A.skel, poseBuf, rest, posedBuf);

  // metres; re-ground after posing (the stance changes the lowest point)
  const s = fit.scale;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < A.bodyVerts.length; i++) {
    const y = posed[A.bodyVerts[i] * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const off: [number, number, number] = [fit.offset[0], -minY * s, fit.offset[2]];
  const xf = (x: number, y: number, z: number, o: Float32Array, i: number) => {
    o[i] = x * s + off[0];
    o[i + 1] = y * s + off[1];
    o[i + 2] = z * s + off[2];
  };

  // skin
  const sub = subdivide(A.topo, posed, xf);
  const nrm = computeNormals(sub, A.topo.outTris);
  const body: PartMesh = {
    positions: expand(sub, A.render.renderToSubdiv, new Float32Array(A.render.count * 3)),
    normals: expand(nrm, A.render.renderToSubdiv, new Float32Array(A.render.count * 3)),
  };
  const transfer: Transferable[] = [body.positions.buffer, body.normals.buffer];

  // hair, brows, lashes, eyes
  const proxies: Record<string, PartMesh> = {};
  let eyeY = (maxY - 1.2) * s + off[1];
  let eyeZ = 0.08;
  if (channel !== 'ghost') {
    const opts = { rest, scale: s, offset: off };
    for (const p of A.proxies) {
      const active = p.kind === 'eyes' || p.kind === 'cornea' || p.kind === 'eyelashes' || (p.kind === 'hair' && p.name === look.hair) || (p.kind === 'eyebrows' && p.name === look.brows);
      if (!active) continue;
      const positions = fitProxy(p, posed, new Float32Array(p.vertexCount * 3), opts);
      const normals = p.kind === 'hair' ? computeHairNormals(p, positions, posed, new Float32Array(p.vertexCount * 3), 0.6, opts) : computeProxyNormals(p, positions, new Float32Array(p.vertexCount * 3));
      const part: PartMesh = { positions, normals };
      transfer.push(positions.buffer, normals.buffer);
      if (p.kind === 'hair') {
        const tan = computeProxyTangents(p, positions, new Float32Array(p.vertexCount * 3));
        if (tan) {
          part.tangents = tan;
          transfer.push(tan.buffer);
        }
      }
      if (p.kind === 'eyes') {
        let y = 0,
          z = 0;
        const n = positions.length / 3;
        for (let i = 0; i < n; i++) {
          y += positions[i * 3 + 1];
          z += positions[i * 3 + 2];
        }
        eyeY = y / n;
        eyeZ = z / n;
      }
      proxies[p.name] = part;
    }
  }

  // ambient-occlusion capsules (posed dm → metres)
  const capsDm = computeCapsules(A.skel, poseBuf, joints, rest);
  const capsules = new Float32Array(capsDm.length);
  for (let i = 0; i < capsDm.length; i += 7) {
    capsules[i] = capsDm[i] * s + off[0];
    capsules[i + 1] = capsDm[i + 1] * s + off[1];
    capsules[i + 2] = capsDm[i + 2] * s + off[2];
    capsules[i + 3] = capsDm[i + 3] * s + off[0];
    capsules[i + 4] = capsDm[i + 4] * s + off[1];
    capsules[i + 5] = capsDm[i + 5] * s + off[2];
    capsules[i + 6] = capsDm[i + 6] * s;
  }
  transfer.push(capsules.buffer);

  // tape loops: lengths are measured on the rest mesh (fit.girths), the rings are drawn on the posed body
  const girths: Girth[] = [];
  for (const k of Object.keys(fit.girths)) {
    const loop = RULER[k];
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const v of loop) {
      cx += posed[v * 3];
      cy += posed[v * 3 + 1];
      cz += posed[v * 3 + 2];
    }
    cx /= loop.length;
    cy /= loop.length;
    cz /= loop.length;
    const ring: number[] = [];
    for (const v of loop) {
      const x = posed[v * 3],
        y = posed[v * 3 + 1],
        z = posed[v * 3 + 2];
      const dx = x - cx,
        dy = y - cy,
        dz = z - cz;
      const l = Math.hypot(dx, dy, dz) || 1;
      const push = 0.04 / l; // 4 mm off the skin
      ring.push((x + dx * push) * s + off[0], (y + dy * push) * s + off[1], (z + dz * push) * s + off[2]);
    }
    girths.push({ key: k, label: GIRTH_LABEL[k as GirthKey] ?? k, cm: fit.girths[k], ring });
  }

  const msg: FrameMsg = {
    type: 'frame',
    id,
    channel,
    body,
    proxies,
    capsules,
    girths,
    info: fit.info,
    head: { eyeY, eyeZ, topY: maxY * s + off[1] },
    heightM: (maxY - minY) * s,
    ms: performance.now() - t0,
  };
  return { msg, transfer };
}

// ── request queue: only the latest request per channel matters ──
type MorphReq = Extract<HumanReq, { type: 'morph' }>;
const pending = new Map<string, MorphReq>();
let busy = false;
async function pump() {
  if (busy || !assets) return;
  busy = true;
  try {
    while (pending.size) {
      const [ch, req] = pending.entries().next().value as [string, MorphReq];
      pending.delete(ch);
      try {
        const r = build(assets, req.input, req.look, req.channel, req.id);
        post(r.msg, r.transfer);
      } catch (e) {
        post({ type: 'error', id: req.id, message: String((e as Error)?.stack ?? e) });
      }
      await new Promise((res) => setTimeout(res, 0));
    }
  } finally {
    busy = false;
  }
}

self.onmessage = async (e: MessageEvent<HumanReq>) => {
  const req = e.data;
  try {
    if (req.type === 'init') {
      assets ??= await loadAssets(req.baseUrl);
      const A = assets;
      const proxies: ProxyInfo[] = A.proxies.map((p) => ({
        name: p.name,
        kind: p.kind,
        label: p.label,
        tags: p.tags,
        indices: p.indices.slice(),
        uvs: p.uvs.slice(),
        texture: p.texture,
        textures: p.textures ?? {},
        tint: Array.from(p.tint),
        render: p.render,
        hasDir: !!p.dir,
      }));
      const rest = expand(A.restSub, A.render.renderToSubdiv, new Float32Array(A.render.count * 3));
      const ready: HumanRes = {
        type: 'ready',
        id: req.id,
        body: { indices: A.render.indices.slice(), uv: A.render.uv.slice(), rest, renderToSubdiv: A.render.renderToSubdiv.slice(), nSubdiv: A.render.nSubdiv },
        proxies,
        skins: A.uv.meta.textures ?? {},
        wear: A.uv.meta.wear ?? {},
      };
      post(ready, [ready.body.indices.buffer, ready.body.uv.buffer, rest.buffer, ready.body.renderToSubdiv.buffer, ...proxies.flatMap((p) => [p.indices.buffer, p.uvs.buffer])]);
      const r = build(A, req.input, req.look, 'main', req.id);
      post(r.msg, r.transfer);
      pump();
    } else if (req.type === 'morph') {
      pending.set(req.channel, req);
      pump();
    } else if (req.type === 'faceFit') {
      dataOnly ??= assets?.data ?? (await loadHumanData(req.baseUrl));
      const mods = fitFace(dataOnly, macroWeights(macroFor(req.input)), {}, req.ratios);
      post({ type: 'faceFit', id: req.id, mods });
    } else if (req.type === 'faceUV') {
      if (!assets) return;
      const A = assets;
      const r = faceUVs(A.restSub, A.restNormals, req.landmarks);
      // per welded vertex → per render vertex (UV-seam duplicates)
      const uv = expand(r.uv, A.render.renderToSubdiv, new Float32Array(A.render.count * 2), 2);
      const w = expand(r.w, A.render.renderToSubdiv, new Float32Array(A.render.count), 1);
      post({ type: 'faceUV', id: req.id, uv, w }, [uv.buffer, w.buffer]);
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: String((err as Error)?.message ?? err) });
  }
};
