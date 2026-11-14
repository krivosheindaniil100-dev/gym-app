import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BodyInfo } from '../body/model';
import type { HumanInput } from './fit';
import type { FrameMsg, Girth, HumanReq, HumanRes, Look, PartMesh, ProxyInfo } from './human.worker';
import HumanWorker from './human.worker?worker';
import {
  STUDIO_RENDER_SETTINGS,
  applyStudioRenderer,
  computeVertexCavity,
  createCapsuleField,
  createSkinMaterial,
  createStudioEnvironment,
  createStudioFloor,
  setupStudioLights,
  type QualityTier,
  type SkinMaterial,
} from './materials';
import { pickSkinTexture, type UvMeta } from './uvmesh';

export type { Girth };

export interface Appearance {
  /** sRGB hex – the skin texture is re-toned to this colour */
  skinTone: string;
  /** iris texture: brown | brownlight | blue | green | grey (legacy hex values are mapped to the nearest) */
  eyeColor: string;
  hairColor: string;
  /** 'none' | 'buzz' | hair proxy name (short02, short04, ponytail01, long01, bob01) */
  hairStyle: string;
  /** eyebrow proxy name; default by sex */
  brows?: string | null;
  /** selfie crop (dataURL) projected onto the face */
  faceTexture?: string | null;
  /** flattened [mpIndex, u, v, …] landmarks in the texture */
  faceLandmarks?: number[] | null;
  /** average skin colour of the selfie */
  faceMean?: string | null;
}

export const DEFAULT_APPEARANCE: Appearance = { skinTone: '#c39880', eyeColor: 'brown', hairColor: '#2b2119', hairStyle: 'buzz' };

export interface HumanViewerProps {
  input: HumanInput;
  ghost?: HumanInput | null;
  appearance?: Appearance;
  showRings?: boolean;
  view?: { name: 'front' | 'side' | 'back' | 'face'; nonce: number };
  onMeasured?: (info: BodyInfo, girths: Girth[]) => void;
  className?: string;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function humanKey(i: HumanInput | null | undefined) {
  if (!i) return '';
  return JSON.stringify([i.sex, i.heightCm.toFixed(1), i.weight.toFixed(2), i.fatKg.toFixed(2), i.ffm.toFixed(2), (i.smm ?? 0).toFixed(2), i.age ?? 0, i.pattern ?? null, i.persona ?? null]);
}

const EYE_KEYS = ['brown', 'brownlight', 'blue', 'green', 'grey'] as const;
const EYE_SWATCH: Record<string, string> = { brown: '#5b3a22', brownlight: '#8a6238', blue: '#4f7ca8', green: '#6c7a3c', grey: '#7f8e9c' };
/** Map a legacy hex eye colour to the nearest iris texture. */
export function eyeKey(v: string): string {
  if ((EYE_KEYS as readonly string[]).includes(v)) return v;
  try {
    const c = new THREE.Color(v);
    let best = 'brown';
    let bd = Infinity;
    for (const k of EYE_KEYS) {
      const s = new THREE.Color(EYE_SWATCH[k]);
      const d = (c.r - s.r) ** 2 + (c.g - s.g) ** 2 + (c.b - s.b) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  } catch {
    return 'brown';
  }
}

function lookFor(a: Appearance, sex: 'male' | 'female'): Look {
  const hair = a.hairStyle === 'none' || a.hairStyle === 'buzz' || a.hairStyle === 'short' ? (a.hairStyle === 'short' ? 'short02' : null) : a.hairStyle;
  return { hair, brows: a.brows ?? (sex === 'male' ? 'eyebrow001' : 'eyebrow010'), pose: 1 };
}
const scalpAmount = (a: Appearance) => (a.hairStyle === 'none' ? 0 : a.hairStyle === 'buzz' ? 0.8 : 0.55);

/**
 * Hair cards: the texture alpha is feathered at build time; here the strand luminance pushes the edge in and out, so a
 * card ends in wisps instead of a paper cut-out. Interior texels (alpha = 1) are untouched.
 */
function softHair<T extends THREE.MeshStandardMaterial>(m: T): T {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
      #ifdef USE_MAP
      {
        float ha = sampledDiffuseColor.a;
        float rel = clamp(dot(sampledDiffuseColor.rgb, vec3(0.3333)) / 0.54, 0.0, 2.0);
        ha += (rel - 1.0) * 1.6 * ha * (1.0 - ha);
        diffuseColor.a = opacity * smoothstep(0.3, 0.9, ha);
      }
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'softHair';
  return m;
}

function pickTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad/i.test(nav.userAgent);
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 3) return 'low';
  if (mobile) return (nav.hardwareConcurrency ?? 8) >= 8 ? 'medium' : 'low';
  return 'high';
}

function makeGhostMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color('#ffb547') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float a = pow(f, 2.2) * 0.95; gl_FragColor = vec4(uColor*a, a); }`,
  });
}

export default function HumanViewer({ input, ghost, appearance = DEFAULT_APPEARANCE, showRings, view, onMeasured, className }: HumanViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [epoch, setEpoch] = useState(0); // bumped to rebuild everything after a lost WebGL context
  const api = useRef<{
    request: (ch: 'main' | 'ghost', i: HumanInput, a: Appearance) => void;
    setRings: (on: boolean) => void;
    setGhostVisible: (on: boolean) => void;
    setView: (v: 'front' | 'side' | 'back' | 'face') => void;
    setAppearance: (a: Appearance) => void;
    ready: boolean;
  } | null>(null);
  const onMeasuredRef = useRef(onMeasured);
  onMeasuredRef.current = onMeasured;
  const latest = useRef({ input, ghost, showRings, appearance });
  latest.current = { input, ghost, showRings, appearance };

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    const sex = input.sex;
    const baseUrl = new URL(import.meta.env.BASE_URL + 'human/', location.href).href;
    const tierName = pickTier();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer(STUDIO_RENDER_SETTINGS.context);
    } catch (e) {
      console.error('WebGL unavailable', e);
      setStatus('error');
      return;
    }
    const tier = applyStudioRenderer(renderer, tierName);
    let pixelRatio = renderer.getPixelRatio();
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    const env = createStudioEnvironment(renderer);
    scene.environment = env.texture;
    scene.environmentIntensity = STUDIO_RENDER_SETTINGS.environmentIntensity;

    const H0 = input.heightCm / 100;
    const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
    camera.position.set(0, H0 * 0.56, 4.6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, H0 * 0.52, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 0.45;
    controls.maxDistance = 7;
    controls.minPolarAngle = Math.PI * 0.18;
    controls.maxPolarAngle = Math.PI * 0.6;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.55;
    controls.rotateSpeed = 0.75;
    let idleTimer: number | undefined;
    controls.addEventListener('start', () => {
      controls.autoRotate = false;
      window.clearTimeout(idleTimer);
    });
    controls.addEventListener('end', () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => (controls.autoRotate = true), 6000);
    });

    const rig = setupStudioLights(scene, { tier: tierName, height: H0 });
    const field = createCapsuleField();
    field.setGround(0);
    const floor = createStudioFloor({ capsules: field });
    floor.mesh.position.y = 0.0005;
    scene.add(floor.mesh);

    const group = new THREE.Group();
    scene.add(group);
    const rings = new THREE.Group();
    scene.add(rings);
    const ghostMat = makeGhostMaterial();
    const ghostGeom = new THREE.BufferGeometry();
    const ghostMesh = new THREE.Mesh(ghostGeom, ghostMat);
    ghostMesh.visible = false;
    ghostMesh.renderOrder = 6;
    ghostMesh.frustumCulled = false;
    scene.add(ghostMesh);

    // ── state ──
    let skin: SkinMaterial | null = null;
    const bodyGeom = new THREE.BufferGeometry();
    let bodyMesh: THREE.Mesh | null = null;
    let proxyInfo = new Map<string, ProxyInfo>();
    const proxyMesh = new Map<string, { mesh: THREE.Mesh; geom: THREE.BufferGeometry; mat: THREE.Material; mat2?: THREE.Material }>();
    const textures = new Map<string, THREE.Texture>();
    let skins: NonNullable<UvMeta['textures']> = {};
    let skinKey: string | null = null;
    let nSubdiv = 0;
    let r2s: Uint32Array | null = null;
    let sceneReady = false;
    let pendingFrame: FrameMsg | null = null;
    let cur: { body: PartMesh; proxies: Record<string, PartMesh> } | null = null;
    let anim: { from: Record<string, PartMesh>; to: Record<string, PartMesh>; t0: number; dur: number } | null = null;
    let ringsOn = !!latest.current.showRings;
    let ghostOn = false;
    let ghostHas = false;
    let lastGirths: Girth[] = [];
    let head = { eyeY: H0 * 0.93, eyeZ: 0.08, topY: H0 };
    let heightM = H0;
    let faceKey = '';
    let appliedLookKey = '';

    const texLoader = new THREE.TextureLoader();
    const loadTex = async (path: string, srgb: boolean): Promise<THREE.Texture> => {
      const k = path + (srgb ? ':s' : ':l');
      const have = textures.get(k);
      if (have) return have;
      const t = await texLoader.loadAsync(baseUrl + path);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      textures.set(k, t);
      return t;
    };
    const linear = (hex: string): [number, number, number] => {
      const c = new THREE.Color(hex); // Color stores linear components
      return [c.r, c.g, c.b];
    };
    const skinTexFor = (a: Appearance) => {
      const meta = { layout: { vt: [0, 0], corners: [0, 0] }, textures: skins } as UvMeta;
      return pickSkinTexture(meta, sex, linear(a.skinTone)) ?? Object.keys(skins).find((k) => k.endsWith(sex)) ?? Object.keys(skins)[0];
    };
    const meanColor = (key: string) => {
      const m = skins[key].meanSrgb;
      return new THREE.Color().setRGB(m[0], m[1], m[2], THREE.SRGBColorSpace);
    };
    /** hair cards are grey-ish (linear luminance ≈ 0.54): multiply to reach the wanted colour */
    const hairTint = (hex: string, texLum = 0.54) => {
      const [r, g, b] = linear(hex);
      return new THREE.Color().setRGB(Math.min(2, r / texLum), Math.min(2, g / texLum), Math.min(2, b / texLum));
    };

    const setAttr = (g: THREE.BufferGeometry, name: string, arr: Float32Array, size: number) => {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (a && a.array.length === arr.length) {
        (a.array as Float32Array).set(arr);
        a.needsUpdate = true;
      } else g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(arr), size));
    };

    async function makeProxy(info: ProxyInfo, a: Appearance) {
      const geom = new THREE.BufferGeometry();
      geom.setIndex(new THREE.BufferAttribute(info.indices, 1));
      geom.setAttribute('uv', new THREE.BufferAttribute(info.uvs, 2));
      let mat: THREE.Material;
      const h = info.render;
      if (info.kind === 'eyes') {
        const map = await loadTex(info.textures[eyeKey(a.eyeColor)] ?? info.texture!, true);
        mat = new THREE.MeshStandardMaterial({ map, roughness: 0.35, metalness: 0 });
      } else if (info.kind === 'cornea') {
        mat = new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.03, metalness: 0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      } else if (info.kind === 'hair') {
        const map = await loadTex(info.texture!, true);
        mat = softHair(new THREE.MeshStandardMaterial({ map, color: hairTint(a.hairColor), side: THREE.DoubleSide, alphaTest: h.alphaTest ?? 0.5, alphaToCoverage: true, roughness: h.roughness ?? 0.85, metalness: 0 }));
      } else {
        const map = await loadTex(info.texture!, true);
        const brow = info.kind === 'eyebrows';
        const m = new THREE.MeshStandardMaterial({
          map,
          color: brow ? new THREE.Color(a.hairColor).multiplyScalar(0.75) : new THREE.Color('#140d09'),
          opacity: brow ? 1 : sex === 'male' ? 0.5 : 0.9,
          transparent: true,
          alphaTest: 0.02,
          depthWrite: false,
          side: brow ? THREE.FrontSide : THREE.DoubleSide,
          roughness: 0.8,
          metalness: 0,
        });
        if (brow) {
          m.polygonOffset = true;
          m.polygonOffsetFactor = -2;
          m.polygonOffsetUnits = -4;
        }
        mat = m;
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = h.renderOrder ?? 0;
      mesh.frustumCulled = false;
      mesh.castShadow = info.kind === 'hair';
      mesh.visible = false;
      group.add(mesh);
      let mat2: THREE.Material | undefined;
      if (info.kind === 'hair') {
        // second pass: the feathered strand tips the cut-out pass discards, alpha-blended without depth writes
        const src = mat as THREE.MeshStandardMaterial;
        const m2 = softHair(new THREE.MeshStandardMaterial({ map: src.map, side: THREE.DoubleSide, transparent: true, alphaTest: 0.03, depthWrite: false, roughness: src.roughness, metalness: 0 }));
        m2.color = src.color; // shared instance: one tint for both passes
        const fringe = new THREE.Mesh(geom, m2);
        fringe.renderOrder = 6;
        fringe.frustumCulled = false;
        mesh.add(fringe);
        mat2 = m2;
      }
      const rec = { mesh, geom, mat, mat2 };
      proxyMesh.set(info.name, rec);
      return rec;
    }

    const buildRings = (girths: Girth[]) => {
      lastGirths = girths;
      for (const c of rings.children) (c as THREE.LineLoop).geometry.dispose();
      rings.clear();
      for (const g of girths) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < g.ring.length; i += 3) pts.push(new THREE.Vector3(g.ring[i], g.ring[i + 1], g.ring[i + 2]));
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
        line.renderOrder = 5;
        rings.add(line);
      }
      rings.visible = ringsOn;
    };
    const ringMat = new THREE.LineBasicMaterial({ color: 0x7cf7c8, depthTest: true });

    const labelEls = new Map<string, HTMLDivElement>();
    const renderLabels = () => {
      const box = labelsRef.current;
      if (!box) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const seen = new Set<string>();
      if (ringsOn && cur) {
        const v = new THREE.Vector3();
        const anchors: { g: Girth; x: number; y: number }[] = [];
        for (const g of lastGirths) {
          let bx = -Infinity,
            by = 0;
          for (let i = 0; i < g.ring.length; i += 3) {
            v.set(g.ring[i], g.ring[i + 1], g.ring[i + 2]).project(camera);
            if (v.x > bx) {
              bx = v.x;
              by = v.y;
            }
          }
          anchors.push({ g, x: ((bx + 1) / 2) * w + 6, y: ((1 - by) / 2) * h - 9 });
        }
        anchors.sort((a, b) => a.y - b.y);
        for (let i = 1; i < anchors.length; i++) if (anchors[i].y < anchors[i - 1].y + 21) anchors[i].y = anchors[i - 1].y + 21;
        for (const a of anchors) {
          let el = labelEls.get(a.g.key);
          if (!el) {
            el = document.createElement('div');
            el.className = 'ring-label';
            box.appendChild(el);
            labelEls.set(a.g.key, el);
          }
          const text = `${a.g.label} ${a.g.cm.toFixed(1)}`;
          if (el.textContent !== text) el.textContent = text;
          el.style.transform = `translate(${Math.max(0, Math.min(a.x, w - 130))}px, ${a.y}px)`;
          el.style.display = '';
          seen.add(a.g.key);
        }
      }
      for (const [k, el] of labelEls) if (!seen.has(k)) el.style.display = 'none';
    };

    function applyParts(parts: Record<string, PartMesh>) {
      for (const [k, pm] of Object.entries(parts)) {
        const g = k === 'body' ? bodyGeom : proxyMesh.get(k)?.geom;
        if (!g) continue;
        setAttr(g, 'position', pm.positions, 3);
        setAttr(g, 'normal', pm.normals, 3);
      }
    }

    async function applyFrame(m: FrameMsg) {
      // make sure every proxy of this frame has a mesh (textures load on demand)
      for (const name of Object.keys(m.proxies)) {
        if (!proxyMesh.has(name)) {
          const info = proxyInfo.get(name);
          if (info) await makeProxy(info, latest.current.appearance);
        }
      }
      if (disposed) return;
      const parts: Record<string, PartMesh> = { body: m.body, ...m.proxies };
      const first = !cur;
      const sameSet = cur && Object.keys(cur.proxies).sort().join() === Object.keys(m.proxies).sort().join();
      if (first || !sameSet) {
        anim = null;
        applyParts(parts);
      } else {
        const from: Record<string, PartMesh> = {};
        for (const k of Object.keys(parts)) {
          const g = k === 'body' ? bodyGeom : proxyMesh.get(k)!.geom;
          from[k] = {
            positions: new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array),
            normals: new Float32Array((g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array),
          };
        }
        anim = { from, to: parts, t0: performance.now(), dur: 900 };
      }
      for (const [name, rec] of proxyMesh) rec.mesh.visible = name in m.proxies;
      cur = { body: m.body, proxies: m.proxies };
      if (first && r2s) {
        // static crease occlusion (eye sockets, nostrils, lips, navel…) on the welded mesh, then per render vertex
        const welded = m.body.positions.subarray(0, nSubdiv * 3);
        const idx = bodyGeom.getIndex()!.array as Uint32Array;
        const wIdx = new Uint32Array(idx.length);
        for (let i = 0; i < idx.length; i++) wIdx[i] = r2s[idx[i]];
        const cavW = computeVertexCavity(welded, wIdx);
        const cav = new Float32Array(r2s.length);
        for (let i = 0; i < r2s.length; i++) cav[i] = cavW[r2s[i]];
        bodyGeom.setAttribute('aCavity', new THREE.BufferAttribute(cav, 1));
      }
      bodyGeom.computeBoundingSphere();
      skin?.setCapsules(m.capsules, m.capsules.length / 7);
      head = m.head;
      heightM = m.heightM;
      rig.setSubject(heightM, new THREE.Vector3(0, heightM / 2, 0));
      buildRings(m.girths);
      onMeasuredRef.current?.(m.info, m.girths);
      if (first) {
        if (bodyMesh) bodyMesh.visible = true;
        setStatus('ready');
        if (api.current) api.current.ready = true;
        const L = latest.current;
        request('main', L.input, L.appearance);
        if (L.ghost) request('ghost', L.ghost, L.appearance);
      }
    }

    function applyFace(a: Appearance) {
      const k = (a.faceTexture?.length ?? 0) + ':' + (a.faceLandmarks?.slice(0, 6).join(',') ?? '');
      if (k === faceKey || !skin) return;
      faceKey = k;
      if (!a.faceTexture || !a.faceLandmarks?.length) {
        skin.setFace(null);
        return;
      }
      texLoader.load(a.faceTexture, (tex) => {
        if (disposed || !skin) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        pendingFaceTex = { tex, mean: a.faceMean ?? a.skinTone };
        worker.postMessage({ type: 'faceUV', id: ++reqId, landmarks: a.faceLandmarks! } satisfies HumanReq);
      });
    }
    let pendingFaceTex: { tex: THREE.Texture; mean: string } | null = null;

    const worker: Worker = new HumanWorker();
    let reqId = 0;
    const sentKey: Record<string, string> = { main: '', ghost: '' };
    const request = (ch: 'main' | 'ghost', i: HumanInput, a: Appearance) => {
      const look = lookFor(a, sex);
      const k = humanKey(i) + JSON.stringify(look);
      if (sentKey[ch] === k) return;
      sentKey[ch] = k;
      worker.postMessage({ type: 'morph', id: ++reqId, channel: ch, input: i, look } satisfies HumanReq);
    };

    async function setupScene(m: Extract<HumanRes, { type: 'ready' }>) {
      const a = latest.current.appearance;
      proxyInfo = new Map(m.proxies.map((p) => [p.name, p]));
      skins = m.skins;
      nSubdiv = m.body.nSubdiv;
      r2s = m.body.renderToSubdiv;
      bodyGeom.setIndex(new THREE.BufferAttribute(m.body.indices, 1));
      bodyGeom.setAttribute('uv', new THREE.BufferAttribute(m.body.uv, 2));
      bodyGeom.setAttribute('aRest', new THREE.BufferAttribute(m.body.rest, 3));
      const n = m.body.rest.length / 3;
      bodyGeom.setAttribute('aFaceUV', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
      bodyGeom.setAttribute('aFaceW', new THREE.BufferAttribute(new Float32Array(n), 1));
      bodyGeom.setAttribute('aCavity', new THREE.BufferAttribute(new Float32Array(n), 1));
      ghostGeom.setIndex(new THREE.BufferAttribute(m.body.indices, 1));

      skinKey = skinTexFor(a);
      const wear = m.wear[sex];
      const [map, mask] = await Promise.all([loadTex(skins[skinKey].file, true), wear ? loadTex(wear.file, false) : Promise.resolve(null)]);
      if (disposed) return;
      skin = createSkinMaterial({
        tier: tierName,
        tone: a.skinTone,
        map,
        texMean: meanColor(skinKey),
        retone: 1,
        maskMap: mask,
        female: sex === 'female',
        fabricColor: '#2b3442',
        fabricBandColor: '#11151c',
        hasUv: true,
        capsules: field,
        cavity: true,
        faceProjection: true,
        scalp: { color: a.hairColor, amount: scalpAmount(a) },
      });
      bodyMesh = new THREE.Mesh(bodyGeom, skin.material);
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;
      bodyMesh.frustumCulled = false;
      bodyMesh.visible = false;
      group.add(bodyMesh);
      sceneReady = true;
      applyFace(a);
      appliedLookKey = JSON.stringify([a.skinTone, a.eyeColor, a.hairColor, a.hairStyle]);
      if (pendingFrame) {
        const f = pendingFrame;
        pendingFrame = null;
        await applyFrame(f);
      }
    }

    worker.onmessage = (e: MessageEvent<HumanRes>) => {
      if (disposed) return;
      const m = e.data;
      if (m.type === 'error') {
        console.error('human worker:', m.message);
        if (!cur) setStatus('error');
        return;
      }
      if (m.type === 'ready') {
        setupScene(m).catch((err) => {
          console.error('human viewer setup failed', err);
          setStatus('error');
        });
        return;
      }
      if (m.type === 'faceUV') {
        if (!skin || !pendingFaceTex) return;
        (bodyGeom.getAttribute('aFaceUV') as THREE.BufferAttribute).copyArray(m.uv).needsUpdate = true;
        (bodyGeom.getAttribute('aFaceW') as THREE.BufferAttribute).copyArray(m.w).needsUpdate = true;
        skin.setFace(pendingFaceTex.tex, pendingFaceTex.mean);
        pendingFaceTex = null;
        return;
      }
      if (m.type === 'frame') {
        if (m.channel === 'ghost') {
          setAttr(ghostGeom, 'position', m.body.positions, 3);
          setAttr(ghostGeom, 'normal', m.body.normals, 3);
          ghostHas = true;
          ghostMesh.visible = ghostOn;
          return;
        }
        if (!sceneReady) pendingFrame = m;
        else applyFrame(m).catch((err) => console.error('human frame failed', err));
      }
    };
    worker.onerror = (e) => {
      console.error('human worker crashed', e.message);
      if (!cur) setStatus('error');
    };

    const firstLook = lookFor(latest.current.appearance, sex);
    sentKey.main = humanKey(input) + JSON.stringify(firstLook);
    worker.postMessage({ type: 'init', id: ++reqId, input, baseUrl, look: firstLook } satisfies HumanReq);

    // ── public API for the React effects ──
    let viewAnim: { from: number; to: number; t0: number } | null = null;
    let zoomAnim: { fromT: THREE.Vector3; toT: THREE.Vector3; fromD: number; toD: number; t0: number } | null = null;
    let fitDist = 5;
    /** head-and-shoulders portrait: the whole head (≈0.25 m tall, 0.2 m wide with ears) plus margins */
    const faceDist = () => {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const headH = Math.max(0.22, (head.topY - head.eyeY) * 2.15);
      return Math.max((headH * 2.25) / 2 / tan, 0.3 / 2 / tan / camera.aspect);
    };
    api.current = {
      request,
      ready: false,
      setRings: (on) => {
        ringsOn = on;
        rings.visible = on;
        renderLabels();
      },
      setGhostVisible: (on) => {
        ghostOn = on;
        ghostMesh.visible = on && ghostHas;
      },
      setView: (v) => {
        const face = v === 'face';
        zoomAnim = {
          fromT: controls.target.clone(),
          toT: face ? new THREE.Vector3(0, head.eyeY - 0.045, 0) : new THREE.Vector3(0, heightM * 0.5, 0),
          fromD: camera.position.distanceTo(controls.target),
          toD: face ? faceDist() : fitDist,
          t0: performance.now(),
        };
        const target = v === 'front' || face ? 0 : v === 'side' ? Math.PI / 2 : Math.PI;
        const c = controls.getAzimuthalAngle();
        let to = target;
        while (to - c > Math.PI) to -= Math.PI * 2;
        while (to - c < -Math.PI) to += Math.PI * 2;
        controls.autoRotate = false;
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => (controls.autoRotate = !face), 8000);
        viewAnim = { from: c, to, t0: performance.now() };
      },
      setAppearance: (a) => {
        if (!skin || !sceneReady) return;
        const key = JSON.stringify([a.skinTone, a.eyeColor, a.hairColor, a.hairStyle]);
        if (key !== appliedLookKey) {
          appliedLookKey = key;
          skin.setTone(a.skinTone);
          skin.setScalp(a.hairColor, scalpAmount(a));
          const want = skinTexFor(a);
          if (want && want !== skinKey) {
            skinKey = want;
            loadTex(skins[want].file, true).then((map) => !disposed && skin && skin.setMaps({ map, texMean: meanColor(want) }));
          }
          for (const [name, rec] of proxyMesh) {
            const info = proxyInfo.get(name)!;
            const mat = rec.mat as THREE.MeshStandardMaterial;
            if (info.kind === 'hair') mat.color.copy(hairTint(a.hairColor));
            else if (info.kind === 'eyebrows') mat.color.set(a.hairColor).multiplyScalar(0.75);
            else if (info.kind === 'eyes') {
              const path = info.textures[eyeKey(a.eyeColor)];
              if (path) loadTex(path, true).then((map) => !disposed && ((mat.map = map), (mat.needsUpdate = true)));
            }
          }
        }
        applyFace(a);
        request('main', latest.current.input, a); // hair style / brows are built by the worker
      },
    };

    // ── size, dynamic resolution ──
    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + 'px';
      renderer.domElement.style.height = h + 'px';
      camera.aspect = w / h;
      const Hm = latest.current.input.heightCm / 100;
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const d = Math.max((Hm * 1.14) / 2 / tan, 0.95 / 2 / tan / camera.aspect);
      fitDist = d;
      if (!zoomAnim && Math.abs(controls.target.y - Hm * 0.5) < 0.2) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        controls.target.set(0, Hm * 0.5, 0);
        camera.position.copy(controls.target).addScaledVector(dir, d);
      }
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver((ents) => (visible = ents[0]?.isIntersecting ?? true));
    io.observe(host);
    let lastT = performance.now();
    let ema = 16;
    let frames = 0;
    let lost = false;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (!visible || document.hidden || lost) {
        lastT = now;
        return;
      }
      const dt = Math.min(100, now - lastT);
      lastT = now;
      ema += (dt - ema) * 0.08;
      // adaptive resolution: keep the frame time under ~28 ms on slow GPUs, restore quality on fast ones
      if (++frames % 45 === 0 && frames > 90 && !anim) {
        if (ema > 28 && pixelRatio > 1) pixelRatio = Math.max(1, pixelRatio - 0.25);
        else if (ema < 15 && pixelRatio < Math.min(window.devicePixelRatio || 1, tier.pixelRatioCap)) pixelRatio = Math.min(tier.pixelRatioCap, pixelRatio + 0.25);
        if (Math.abs(renderer.getPixelRatio() - pixelRatio) > 0.01) renderer.setPixelRatio(pixelRatio);
      }
      if (anim) {
        const t = Math.min(1, (now - anim.t0) / anim.dur);
        const e = easeInOut(t);
        for (const [k, to] of Object.entries(anim.to)) {
          const from = anim.from[k];
          const g = k === 'body' ? bodyGeom : proxyMesh.get(k)?.geom;
          if (!from || !g) continue;
          const pa = g.getAttribute('position') as THREE.BufferAttribute;
          const na = g.getAttribute('normal') as THREE.BufferAttribute;
          const P = pa.array as Float32Array;
          const N = na.array as Float32Array;
          if (P.length !== to.positions.length) continue;
          for (let i = 0; i < P.length; i++) {
            P[i] = from.positions[i] + (to.positions[i] - from.positions[i]) * e;
            N[i] = from.normals[i] + (to.normals[i] - from.normals[i]) * e;
          }
          pa.needsUpdate = true;
          na.needsUpdate = true;
        }
        if (t >= 1) anim = null;
      }
      if (viewAnim) {
        const t = Math.min(1, (now - viewAnim.t0) / 700);
        const a = viewAnim.from + (viewAnim.to - viewAnim.from) * easeInOut(t);
        const r = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
        camera.position.x = controls.target.x + Math.sin(a) * r;
        camera.position.z = controls.target.z + Math.cos(a) * r;
        if (t >= 1) viewAnim = null;
      }
      if (zoomAnim) {
        const t = Math.min(1, (now - zoomAnim.t0) / 800);
        const e = easeInOut(t);
        const dir = camera.position.clone().sub(controls.target).normalize();
        controls.target.lerpVectors(zoomAnim.fromT, zoomAnim.toT, e);
        camera.position.copy(controls.target).addScaledVector(dir, zoomAnim.fromD + (zoomAnim.toD - zoomAnim.fromD) * e);
        if (t >= 1) zoomAnim = null;
      }
      controls.update();
      rig.update(camera);
      renderer.render(scene, camera);
      if (ringsOn) renderLabels();
    };
    tick();

    // ── WebGL context loss (app in background, memory pressure): rebuild from scratch when it comes back ──
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
    };
    const onRestored = () => !disposed && setEpoch((n) => n + 1);
    renderer.domElement.addEventListener('webglcontextlost', onLost);
    renderer.domElement.addEventListener('webglcontextrestored', onRestored);

    return () => {
      disposed = true;
      window.clearTimeout(idleTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      worker.terminate();
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      controls.dispose();
      bodyGeom.dispose();
      ghostGeom.dispose();
      ghostMat.dispose();
      ringMat.dispose();
      for (const c of rings.children) (c as THREE.LineLoop).geometry.dispose();
      for (const rec of proxyMesh.values()) {
        rec.geom.dispose();
        rec.mat.dispose();
        rec.mat2?.dispose();
      }
      for (const t of textures.values()) t.dispose();
      skin?.dispose();
      floor.dispose();
      rig.dispose();
      env.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelEls.forEach((el) => el.remove());
      api.current = null;
      setStatus('loading');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.sex, Math.round(input.heightCm), epoch]);

  // ── react to prop changes ──
  useEffect(() => {
    if (api.current?.ready) api.current.request('main', input, latest.current.appearance);
  }, [humanKey(input)]);

  useEffect(() => {
    if (!api.current) return;
    if (ghost) {
      if (api.current.ready) api.current.request('ghost', ghost, latest.current.appearance);
      api.current.setGhostVisible(true);
    } else api.current.setGhostVisible(false);
  }, [humanKey(ghost), status]);

  useEffect(() => {
    api.current?.setRings(!!showRings);
  }, [showRings, status]);

  useEffect(() => {
    if (status === 'ready') api.current?.setAppearance(appearance);
  }, [appearance.skinTone, appearance.eyeColor, appearance.hairColor, appearance.hairStyle, appearance.brows, appearance.faceTexture, appearance.faceLandmarks, status]);

  useEffect(() => {
    if (view) api.current?.setView(view.name);
  }, [view?.nonce]);

  return (
    <div className={`body-viewer ${className ?? ''}`}>
      <div ref={hostRef} className="body-canvas" />
      <div ref={labelsRef} className="ring-labels" />
      {status !== 'ready' && (
        <div className="body-loading">
          {status === 'loading' && <div className="scanline" />}
          <span>{status === 'error' ? 'Не удалось построить 3D-модель. Перезапусти приложение.' : 'Строю модель тела…'}</span>
        </div>
      )}
    </div>
  );
}
