// Copies MediaPipe WASM from node_modules and downloads the pose/face models into public/mediapipe (not committed).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'mediapipe');
mkdirSync(join(out, 'wasm'), { recursive: true });
mkdirSync(join(out, 'models'), { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  copyFileSync(join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm', f), join(out, 'wasm', f));
}
const models = {
  'pose_landmarker_full.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
};
for (const [name, url] of Object.entries(models)) {
  const dest = join(out, 'models', name);
  if (existsSync(dest)) continue;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${url}: ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log('downloaded', name);
}
console.log('mediapipe assets ready');
