/// <reference lib="webworker" />
import { buildBody, type BodyInfo, type BodyInput } from './model';
import { computeArmSkin, morph, polygonize, type ArmSkin } from './mesher';
import { measureBody, type Girth } from './measure';

const TEMPLATE_VERSION = 5;

export type WorkerReq =
  | { type: 'init'; id: number; input: BodyInput }
  | { type: 'morph'; id: number; channel: string; input: BodyInput; measure: boolean };

export type WorkerRes =
  | {
      type: 'mesh';
      id: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      info: BodyInfo;
      girths: Girth[];
      ms: number;
      cached: boolean;
    }
  | { type: 'morph'; id: number; channel: string; positions: Float32Array; normals: Float32Array; info: BodyInfo; girths: Girth[] | null }
  | { type: 'error'; id: number; message: string };

let template: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; key: string; skin: ArmSkin } | null = null;

// ── tiny IndexedDB cache for the template mesh ──
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('bodytwin-mesh', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tpl');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function cacheGet(key: string): Promise<any> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction('tpl', 'readonly');
    const q = tx.objectStore('tpl').get(key);
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => resolve(null);
  });
}
async function cachePut(key: string, value: any) {
  const db = await idb();
  if (!db) return;
  return new Promise<void>((resolve) => {
    const tx = db.transaction('tpl', 'readwrite');
    tx.objectStore('tpl').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

const pending = new Map<string, WorkerReq & { type: 'morph' }>();
let busy = false;

async function handleInit(req: WorkerReq & { type: 'init' }) {
  const t0 = performance.now();
  const key = `v${TEMPLATE_VERSION}:${req.input.sex}:${Math.round(req.input.heightCm)}`;
  const spec = buildBody(req.input);
  let cached = false;
  if (!template || template.key !== key) {
    const c = await cacheGet(key);
    if (c && c.positions && c.indices && c.skin) {
      template = { positions: c.positions, normals: c.normals, indices: c.indices, key, skin: c.skin };
      cached = true;
    } else {
      const m = polygonize(spec);
      const skin = computeArmSkin(spec, m.positions);
      template = { ...m, key, skin };
      cachePut(key, { positions: m.positions, normals: m.normals, indices: m.indices, skin });
    }
  } else cached = true;
  const res = morph(template.positions, template.normals, spec, template.skin);
  const girths = measureBody(spec);
  const msg: WorkerRes = {
    type: 'mesh',
    id: req.id,
    positions: res.positions,
    normals: res.normals,
    indices: template.indices.slice(),
    info: spec.info,
    girths,
    ms: performance.now() - t0,
    cached,
  };
  (self as unknown as Worker).postMessage(msg, [msg.positions.buffer, msg.normals.buffer, msg.indices.buffer]);
}

function handleMorph(req: WorkerReq & { type: 'morph' }) {
  if (!template) return;
  const spec = buildBody(req.input);
  const res = morph(template.positions, template.normals, spec, template.skin);
  const girths = req.measure ? measureBody(spec) : null;
  const msg: WorkerRes = { type: 'morph', id: req.id, channel: req.channel, positions: res.positions, normals: res.normals, info: spec.info, girths };
  (self as unknown as Worker).postMessage(msg, [msg.positions.buffer, msg.normals.buffer]);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (pending.size) {
      const [ch, req] = pending.entries().next().value as [string, WorkerReq & { type: 'morph' }];
      pending.delete(ch);
      try {
        handleMorph(req);
      } catch (e) {
        (self as unknown as Worker).postMessage({ type: 'error', id: req.id, message: String(e) });
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    busy = false;
  }
}

self.onmessage = async (e: MessageEvent<WorkerReq>) => {
  const req = e.data;
  if (req.type === 'init') {
    try {
      await handleInit(req);
      pump();
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'error', id: req.id, message: String(err) });
    }
  } else if (req.type === 'morph') {
    pending.set(req.channel, req); // only the latest request per channel matters
    if (template) pump();
  }
};
