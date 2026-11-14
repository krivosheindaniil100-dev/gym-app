/// <reference lib="webworker" />
import { buildSubdiv, computeNormals, loadHumanData, RULER, subdivide, type HumanData, type SubdivTopo } from './engine';
import { fitHuman, GIRTH_LABEL, macroFor, type HumanInput, type GirthKey } from './fit';
import { macroWeights } from './engine';
import { faceUVs, fitFace } from './face';
import type { BodyInfo } from '../body/model';

export interface PartMesh {
  positions: Float32Array;
  normals: Float32Array;
}

export interface HumanInitMsg {
  type: 'init';
  id: number;
  input: HumanInput;
  baseUrl: string;
}
export interface HumanMorphMsg {
  type: 'morph';
  id: number;
  channel: string;
  input: HumanInput;
}
export interface HumanFaceFitMsg {
  type: 'faceFit';
  id: number;
  baseUrl: string;
  input: HumanInput;
  ratios: number[];
}
export interface HumanFaceUVMsg {
  type: 'faceUV';
  id: number;
  landmarks: number[];
}
export type HumanReq = HumanInitMsg | HumanMorphMsg | HumanFaceFitMsg | HumanFaceUVMsg;

export interface Girth {
  key: string;
  label: string;
  cm: number;
  ring: number[];
}

export type HumanRes =
  | {
      type: 'mesh';
      id: number;
      parts: Record<string, PartMesh>;
      indices: Record<string, Uint32Array>;
      rest: Float32Array; // rest position of subdivided body (for region masks)
      info: BodyInfo;
      girths: Girth[];
      eyes: number[]; // [lx,ly,lz,rx,ry,rz, radius]
      ms: number;
    }
  | { type: 'morph'; id: number; channel: string; parts: Record<string, PartMesh>; info: BodyInfo; girths: Girth[]; eyes: number[] }
  | { type: 'faceFit'; id: number; mods: Record<string, number> }
  | { type: 'faceUV'; id: number; uv: Float32Array; w: Float32Array }
  | { type: 'error'; id: number; message: string };

let data: HumanData | null = null;
let restBody: Float32Array | null = null;
let restNormals: Float32Array | null = null;
const topo: Record<string, SubdivTopo> = {};
const SUBDIV = ['body', 'helper-l-eye', 'helper-r-eye'];
const FLAT = ['helper-l-eyelashes-1', 'helper-l-eyelashes-2', 'helper-r-eyelashes-1', 'helper-r-eyelashes-2'];
let lashTopo: { verts: Uint32Array; tris: Uint32Array } | null = null;

function flatTopo(groups: string[]) {
  const map = new Map<number, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  for (const g of groups) {
    const q = data!.faces[g];
    if (!q) continue;
    for (let f = 0; f < q.length; f += 4) {
      const l = [0, 1, 2, 3].map((k) => {
        const gv = q[f + k];
        let v = map.get(gv);
        if (v === undefined) {
          v = verts.length;
          verts.push(gv);
          map.set(gv, v);
        }
        return v;
      });
      tris.push(l[0], l[1], l[2], l[0], l[2], l[3]);
    }
  }
  return { verts: Uint32Array.from(verts), tris: Uint32Array.from(tris) };
}

const DEG = 0;
void DEG;

function build(input: HumanInput) {
  const fit = fitHuman(data!, input);
  const s = fit.scale;
  const [ox, oy, oz] = fit.offset;
  const xf = (x: number, y: number, z: number, o: Float32Array, i: number) => {
    o[i] = x * s + ox;
    o[i + 1] = y * s + oy;
    o[i + 2] = z * s + oz;
  };
  const parts: Record<string, PartMesh> = {};
  for (const g of SUBDIV) {
    const t = topo[g];
    if (!t) continue;
    const p = subdivide(t, fit.pos, xf);
    parts[g] = { positions: p, normals: computeNormals(p, t.outTris) };
  }
  if (lashTopo) {
    const p = new Float32Array(lashTopo.verts.length * 3);
    for (let i = 0; i < lashTopo.verts.length; i++) xf(fit.pos[lashTopo.verts[i] * 3], fit.pos[lashTopo.verts[i] * 3 + 1], fit.pos[lashTopo.verts[i] * 3 + 2], p, i * 3);
    parts.lashes = { positions: p, normals: computeNormals(p, lashTopo.tris) };
  }
  // tape loops in metres (pushed slightly outward)
  const girths: Girth[] = [];
  for (const k of Object.keys(fit.girths)) {
    const loop = RULER[k];
    const ring: number[] = [];
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const v of loop) {
      cx += fit.pos[v * 3];
      cy += fit.pos[v * 3 + 1];
      cz += fit.pos[v * 3 + 2];
    }
    cx /= loop.length;
    cy /= loop.length;
    cz /= loop.length;
    for (const v of loop) {
      const x = fit.pos[v * 3],
        y = fit.pos[v * 3 + 1],
        z = fit.pos[v * 3 + 2];
      const dx = x - cx,
        dz = z - cz;
      const l = Math.hypot(dx, dz) || 1;
      ring.push((x + (dx / l) * 0.04) * s + ox, y * s + oy, (z + (dz / l) * 0.04) * s + oz);
    }
    girths.push({ key: k, label: GIRTH_LABEL[k as GirthKey] ?? k, cm: fit.girths[k], ring });
  }
  // eye centres for the iris shader
  const eyes: number[] = [];
  for (const g of ['helper-l-eye', 'helper-r-eye']) {
    const pm = parts[g];
    if (!pm) continue;
    let x = 0,
      y = 0,
      z = 0;
    const n = pm.positions.length / 3;
    for (let i = 0; i < n; i++) {
      x += pm.positions[i * 3];
      y += pm.positions[i * 3 + 1];
      z += pm.positions[i * 3 + 2];
    }
    eyes.push(x / n, y / n, z / n);
  }
  let r = 0;
  if (parts['helper-l-eye']) {
    const pm = parts['helper-l-eye'];
    const n = pm.positions.length / 3;
    for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(pm.positions[i * 3] - eyes[0], pm.positions[i * 3 + 1] - eyes[1], pm.positions[i * 3 + 2] - eyes[2]));
  }
  eyes.push(r);
  return { parts, girths, info: fit.info, eyes };
}

function transferList(parts: Record<string, PartMesh>) {
  const t: ArrayBuffer[] = [];
  for (const p of Object.values(parts)) t.push(p.positions.buffer as ArrayBuffer, p.normals.buffer as ArrayBuffer);
  return t;
}

const pending = new Map<string, HumanMorphMsg>();
let busy = false;
async function pump() {
  if (busy || !data) return;
  busy = true;
  try {
    while (pending.size) {
      const [ch, req] = pending.entries().next().value as [string, HumanMorphMsg];
      pending.delete(ch);
      try {
        const r = build(req.input);
        const msg: HumanRes = { type: 'morph', id: req.id, channel: req.channel, ...r };
        (self as unknown as Worker).postMessage(msg, transferList(r.parts));
      } catch (e) {
        (self as unknown as Worker).postMessage({ type: 'error', id: req.id, message: String(e) });
      }
      await new Promise((res) => setTimeout(res, 0));
    }
  } finally {
    busy = false;
  }
}

self.onmessage = async (e: MessageEvent<HumanReq>) => {
  const req = e.data;
  if (req.type === 'init') {
    try {
      const t0 = performance.now();
      if (!data) {
        data = await loadHumanData(req.baseUrl);
        for (const g of SUBDIV) if (data.faces[g]) topo[g] = buildSubdiv(data.faces[g]);
        lashTopo = flatTopo(FLAT);
      }
      const r = build(req.input);
      // rest pose (base mesh, no targets) for region masks
      const bt = topo.body;
      const rest = subdivide(bt, data.base, (x, y, z, o, i) => {
        o[i] = x;
        o[i + 1] = y;
        o[i + 2] = z;
      });
      restBody = rest.slice();
      restNormals = computeNormals(restBody, bt.outTris);
      const indices: Record<string, Uint32Array> = {};
      for (const g of SUBDIV) if (topo[g]) indices[g] = topo[g].outTris.slice();
      if (lashTopo) indices.lashes = lashTopo.tris.slice();
      const msg: HumanRes = { type: 'mesh', id: req.id, ...r, indices, rest, ms: performance.now() - t0 };
      (self as unknown as Worker).postMessage(msg, [...transferList(r.parts), rest.buffer, ...Object.values(indices).map((i) => i.buffer as ArrayBuffer)]);
      pump();
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'error', id: req.id, message: String((err as Error)?.stack ?? err) });
    }
  } else if (req.type === 'morph') {
    pending.set(req.channel, req);
    pump();
  } else if (req.type === 'faceFit') {
    try {
      if (!data) data = await loadHumanData(req.baseUrl);
      const base = macroWeights(macroFor(req.input));
      const mods = fitFace(data, base, {}, req.ratios);
      (self as unknown as Worker).postMessage({ type: 'faceFit', id: req.id, mods } satisfies HumanRes);
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'error', id: req.id, message: String(err) });
    }
  } else if (req.type === 'faceUV') {
    if (!restBody || !restNormals) return;
    const r = faceUVs(restBody, restNormals, req.landmarks);
    (self as unknown as Worker).postMessage({ type: 'faceUV', id: req.id, uv: r.uv, w: r.w } satisfies HumanRes, [r.uv.buffer, r.w.buffer]);
  }
};
