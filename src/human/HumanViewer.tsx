import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BodyInfo } from '../body/model';
import type { HumanInput } from './fit';
import type { Girth, HumanReq, HumanRes, PartMesh } from './human.worker';
import HumanWorker from './human.worker?worker';

export interface Appearance {
  skinTone: string;
  eyeColor: string;
  hairColor: string;
  hairStyle: 'none' | 'short' | 'buzz';
  /** selfie crop (dataURL) projected onto the face */
  faceTexture?: string | null;
  /** flattened [mpIndex, u, v, …] landmarks in the texture */
  faceLandmarks?: number[] | null;
  /** average skin colour of the selfie */
  faceMean?: string | null;
}

export const DEFAULT_APPEARANCE: Appearance = { skinTone: '#c9906f', eyeColor: '#5b4632', hairColor: '#2b2119', hairStyle: 'short' };

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

/* ───────────────────────── materials ───────────────────────── */

const NOISE = /* glsl */ `
float hash3(vec3 p){ p = fract(p*0.3183099 + .1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i+vec3(0,0,0)),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y), f.z);
}
`;

const REGIONS = /* glsl */ `
float ss(float a, float b, float x){ return smoothstep(a, b, x); }
// rest-space (MakeHuman base mesh, decimetres): crotch -0.45, hips 0.1, waist 1.9, underbust 3.2, chest 3.85, eyes y 7.28
float clothMask(vec3 r, float female){
  float ax = abs(r.x);
  float legCut = -1.25 + max(0.0, ax - 1.0) * 0.25;
  float top = r.z < 0.3 ? 1.1 : 0.95;
  float m = ss(legCut - 0.04, legCut + 0.04, r.y) * (1.0 - ss(top - 0.04, top + 0.04, r.y)) * (1.0 - ss(2.0, 2.08, ax));
  if (female > 0.5) {
    float t1 = r.z > 0.8 ? 4.45 : 4.15;
    float tm = ss(2.96, 3.04, r.y) * (1.0 - ss(t1 - 0.04, t1 + 0.04, r.y)) * (1.0 - ss(1.86, 1.95, ax));
    m = max(m, tm);
  }
  return m;
}
float hairMask(vec3 r){
  if (r.y < 6.6) return 0.0;
  vec2 d = vec2(r.x, r.z - 0.6);
  float c = d.y / max(length(d), 1e-4);
  float hy = c > 0.0 ? mix(7.33, 7.8, pow(c, 1.4)) : mix(7.33, 6.92, pow(-c, 0.8));
  float m = ss(hy - 0.03, hy + 0.05, r.y + (vnoise(r * 25.0) - 0.5) * 0.06);
  // keep the ears free
  float ear = (1.0 - ss(0.74, 0.8, abs(r.x))) ;
  m *= mix(1.0, ear, 1.0 - ss(7.45, 7.6, r.y));
  return m;
}
float browMask(vec3 r){
  float ax = abs(r.x);
  if (r.z < 1.1 || ax > 0.62 || ax < 0.07) return 0.0;
  float cy = 7.5 + 0.03 * sin((ax - 0.08) / 0.5 * 3.1416) - 0.04 * ss(0.4, 0.6, ax);
  float th = mix(0.055, 0.03, ss(0.1, 0.55, ax));
  return (1.0 - ss(th * 0.6, th, abs(r.y - cy))) * ss(0.07, 0.12, ax) * (1.0 - ss(0.56, 0.62, ax));
}
float lipMask(vec3 r){
  if (r.z < 1.35) return 0.0;
  float e = length(vec2(r.x / 0.27, (r.y - 6.53) / 0.085));
  return 1.0 - ss(0.75, 1.05, e);
}
float nippleMask(vec3 r){
  float d = length(vec2(abs(r.x) - 0.78, r.y - 3.86));
  return r.z > 1.2 ? 1.0 - ss(0.07, 0.12, d) : 0.0;
}
`;

function makeSkin(tone: string, female: boolean) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(tone),
    roughness: 0.55,
    metalness: 0,
    sheen: 0.22,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color('#ff9f86'),
    clearcoat: 0.06,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.55,
  });
  const uniforms = {
    uFaceTex: { value: null as THREE.Texture | null },
    uFaceOn: { value: 0 },
    uFaceMean: { value: new THREE.Color('#c9906f') },
    uSkin: { value: new THREE.Color(tone) },
    uCloth: { value: new THREE.Color('#1c2028') },
    uHair: { value: new THREE.Color('#2b2119') },
    uHairLift: { value: 0.004 },
    uHairOn: { value: 1 },
    uFemale: { value: female ? 1 : 0 },
    uRim: { value: new THREE.Color('#5fd8ff') },
    uRimI: { value: 0.1 },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader =
      'attribute vec3 aRest;\nattribute vec2 aFaceUV;\nattribute float aFaceW;\nvarying vec3 vRest;\nvarying vec2 vFaceUV;\nvarying float vFaceW;\nuniform float uHairLift;\nuniform float uHairOn;\n' +
      NOISE +
      REGIONS +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vRest = aRest; vFaceUV = aFaceUV; vFaceW = aFaceW;\n transformed += objectNormal * hairMask(aRest) * uHairLift * uHairOn;');
    sh.fragmentShader =
      'varying vec3 vRest;\nvarying vec2 vFaceUV;\nvarying float vFaceW;\nuniform sampler2D uFaceTex;\nuniform float uFaceOn;\nuniform vec3 uFaceMean;\nuniform vec3 uSkin;\nuniform vec3 uCloth;\nuniform vec3 uHair;\nuniform float uHairOn;\nuniform float uFemale;\nuniform vec3 uRim;\nuniform float uRimI;\nfloat gCloth;\nfloat gHair;\n' +
      NOISE +
      REGIONS +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            gCloth = clothMask(vRest, uFemale);
            gHair = hairMask(vRest) * uHairOn;
            float m = vnoise(vRest * 9.0) * 0.6 + vnoise(vRest * 23.0) * 0.4;
            diffuseColor.rgb *= 0.95 + 0.08 * m;
            // lips, nipples – slightly rosier
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.86, 0.58, 0.56), lipMask(vRest) * 0.55);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.55, 0.5), nippleMask(vRest) * 0.5 * (1.0 - uFemale));
            // selfie projected on the face
            float fw = vFaceW * uFaceOn;
            if (fw > 0.001) {
              // transfer only the detail of the photo (brows, lips, features) relative to its mean skin colour,
              // with reduced contrast so the baked photo lighting doesn't double the 3D shading
              vec3 fc = texture2D(uFaceTex, vFaceUV).rgb;
              vec3 rel = pow(max(fc, vec3(1e-4)) / max(uFaceMean, vec3(1e-4)), vec3(0.6));
              vec3 albedo = uSkin * clamp(rel, vec3(0.08), vec3(1.6));
              diffuseColor.rgb = mix(diffuseColor.rgb, albedo, clamp(fw, 0.0, 1.0) * 0.88);
            }
            // eyebrows (procedural only where the selfie isn't used)
            float b = (1.0 - fw) * browMask(vRest) * smoothstep(0.35, 0.75, vnoise(vec3(vRest.x * 260.0, vRest.y * 45.0, vRest.z * 260.0)));
            diffuseColor.rgb = mix(diffuseColor.rgb, uHair * 0.7, clamp(b * 0.9, 0.0, 1.0));
            // short hair: strands along the scalp
            float st = vnoise(vec3(vRest.x * 220.0, vRest.y * 60.0, vRest.z * 220.0));
            vec3 hc = uHair * (0.45 + 0.7 * st * st);
            diffuseColor.rgb = mix(diffuseColor.rgb, hc, gHair);
            diffuseColor.rgb = mix(diffuseColor.rgb, uCloth * (0.85 + 0.3 * vnoise(vRest * 140.0)), gCloth);
          }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = roughnessFactor + (vnoise(vRest * 60.0) - 0.5) * 0.12;
          roughnessFactor = mix(roughnessFactor, 0.4, lipMask(vRest) * 0.6);
          roughnessFactor = mix(roughnessFactor, 0.8, max(gCloth, gHair));`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            vec3 q = vRest * mix(85.0, 180.0, gCloth);
            float h = vnoise(q);
            float hx = vnoise(q + vec3(0.37, 0.0, 0.0)) - h;
            float hy = vnoise(q + vec3(0.0, 0.37, 0.0)) - h;
            float amp = mix(0.05, 0.12, max(gCloth, gHair));
            normal = normalize(normal + vec3(hx, hy, 0.0) * amp);
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            float fr = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            totalEmissiveRadiance += uRim * pow(fr, 4.0) * uRimI * (1.0 - max(gCloth, gHair));
          }`,
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
          {
            float k = 1.0 - max(gCloth, gHair);
            material.sheenColor *= k * k;
            material.clearcoat *= k;
          }`,
        );
  };
  return { mat, uniforms };
}

function makeEye(color: string) {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  const uniforms = {
    uCenter: { value: new THREE.Vector3() },
    uIris: { value: new THREE.Color(color) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'varying vec3 vP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vP = position;');
    sh.fragmentShader =
      'varying vec3 vP;\nuniform vec3 uCenter;\nuniform vec3 uIris;\n' +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 d = normalize(vP - uCenter);
          float c = dot(d, vec3(0.0, 0.0, 1.0));
          float ang = acos(clamp(c, -1.0, 1.0));
          vec3 sclera = vec3(0.93, 0.9, 0.87);
          float iris = 1.0 - smoothstep(0.50, 0.55, ang);
          float pupil = 1.0 - smoothstep(0.17, 0.2, ang);
          float limbal = smoothstep(0.38, 0.53, ang) * iris;
          float streaks = 0.75 + 0.25 * sin(atan(d.y, d.x) * 40.0);
          vec3 ic = uIris * streaks * (1.0 - 0.6 * limbal);
          vec3 col = mix(sclera, ic, iris);
          col = mix(col, vec3(0.02), pupil);
          diffuseColor.rgb = col;
        }`,
      );
  };
  return { mat, uniforms };
}

function makeHair(color: string) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.75, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vP = position;');
    sh.fragmentShader =
      'varying vec3 vP;\n' +
      NOISE +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float s = vnoise(vec3(vP.x * 900.0, vP.y * 120.0, vP.z * 900.0));
          diffuseColor.rgb *= 0.7 + 0.5 * s;
        }`,
      );
  };
  return mat;
}

function makeGhost() {
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

function makeFloor() {
  const g = new THREE.Group();
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(120,200,255,0.16)');
  grd.addColorStop(0.5, 'rgba(90,140,255,0.06)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(140,220,255,0.35)';
  for (let r = 0; r < 4; r++) {
    ctx.globalAlpha = r === 1 ? 0.8 : 0.3;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * (0.2 + r * 0.08), 0, Math.PI * 2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const disk = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 0.001;
  g.add(disk);
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.ShadowMaterial({ opacity: 0.45 }));
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = 0.002;
  shadowPlane.receiveShadow = true;
  g.add(shadowPlane);
  return g;
}

/* ───────────────────────── component ───────────────────────── */

export default function HumanViewer({ input, ghost, appearance = DEFAULT_APPEARANCE, showRings, view, onMeasured, className }: HumanViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const api = useRef<{
    request: (ch: 'main' | 'ghost', i: HumanInput) => void;
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
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
    const H0 = input.heightCm / 100;
    camera.position.set(0, H0 * 0.56, 4.9);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, H0 * 0.52, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 0.6;
    controls.maxDistance = 7;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;
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

    // studio lighting
    scene.add(new THREE.HemisphereLight(0xe6eeff, 0x3a2620, 0.4));
    const key = new THREE.DirectionalLight(0xfff4ea, 1.9);
    key.position.set(1.4, 3.0, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -1.1;
    key.shadow.camera.right = 1.1;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -0.2;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 8;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 4;
    scene.add(key);
    scene.add(key.target);
    key.target.position.set(0, H0 * 0.5, 0);
    const rimA = new THREE.DirectionalLight(0x7fd6ff, 1.6);
    rimA.position.set(-2.4, 1.9, -2.4);
    scene.add(rimA);
    const rimB = new THREE.DirectionalLight(0xb09cff, 1.1);
    rimB.position.set(2.6, 1.3, -2.2);
    scene.add(rimB);
    const fill = new THREE.DirectionalLight(0xffe2cf, 0.5);
    fill.position.set(-2.2, 0.8, 2.0);
    scene.add(fill);
    scene.add(makeFloor());

    const skin = makeSkin(latest.current.appearance.skinTone, input.sex === 'female');
    const eyeL = makeEye(latest.current.appearance.eyeColor);
    const eyeR = makeEye(latest.current.appearance.eyeColor);
    const hairMat = makeHair(latest.current.appearance.hairColor);
    const lashMat = new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.8, side: THREE.DoubleSide });
    const ghostMat = makeGhost();

    const geoms: Record<string, THREE.BufferGeometry> = {};
    const meshes: Record<string, THREE.Mesh> = {};
    const group = new THREE.Group();
    scene.add(group);
    const ghostGeom = new THREE.BufferGeometry();
    const ghostMesh = new THREE.Mesh(ghostGeom, ghostMat);
    ghostMesh.visible = false;
    ghostMesh.renderOrder = 3;
    scene.add(ghostMesh);
    const rings = new THREE.Group();
    scene.add(rings);
    let ringsOn = !!latest.current.showRings;
    let ghostOn = false;
    let lastGirths: Girth[] = [];
    let hairStyle = latest.current.appearance.hairStyle;

    const matFor = (g: string) => (g === 'body' ? skin.mat : g === 'helper-l-eye' ? eyeL.mat : g === 'helper-r-eye' ? eyeR.mat : g === 'helper-hair' ? hairMat : lashMat);

    type Snap = Record<string, PartMesh>;
    let cur: Snap | null = null;
    let anim: { from: Snap; to: Snap; t0: number; dur: number } | null = null;
    let ghostHas = false;

    const setAttr = (g: THREE.BufferGeometry, p: Float32Array, n: Float32Array) => {
      const pa = g.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pa && pa.array.length === p.length) {
        (pa.array as Float32Array).set(p);
        pa.needsUpdate = true;
        const na = g.getAttribute('normal') as THREE.BufferAttribute;
        (na.array as Float32Array).set(n);
        na.needsUpdate = true;
      } else {
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n), 3));
      }
      g.computeBoundingSphere();
    };

    const applySnap = (s: Snap) => {
      for (const [k, pm] of Object.entries(s)) if (geoms[k]) setAttr(geoms[k], pm.positions, pm.normals);
    };

    const buildRings = (girths: Girth[]) => {
      lastGirths = girths;
      rings.clear();
      for (const g of girths) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < g.ring.length; i += 3) pts.push(new THREE.Vector3(g.ring[i], g.ring[i + 1], g.ring[i + 2]));
        rings.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x7cf7c8 })));
      }
      rings.visible = ringsOn;
    };

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
          el.textContent = `${a.g.label} ${a.g.cm.toFixed(1)}`;
          el.style.transform = `translate(${Math.max(0, Math.min(a.x, w - 130))}px, ${a.y}px)`;
          el.style.display = '';
          seen.add(a.g.key);
        }
      }
      for (const [k, el] of labelEls) if (!seen.has(k)) el.style.display = 'none';
    };

    const updateEyes = (eyes: number[]) => {
      // two eyes share one material → use per-mesh onBeforeRender to set the centre
      if (meshes['helper-l-eye']) (meshes['helper-l-eye'].userData.center as THREE.Vector3).set(eyes[0], eyes[1], eyes[2]);
      if (meshes['helper-r-eye']) (meshes['helper-r-eye'].userData.center as THREE.Vector3).set(eyes[3], eyes[4], eyes[5]);
    };

    let faceKey = '';
    const texLoader = new THREE.TextureLoader();
    const applyFace = (a: Appearance) => {
      const k = (a.faceTexture?.length ?? 0) + ':' + (a.faceLandmarks?.slice(0, 6).join(',') ?? '');
      if (k === faceKey) return;
      faceKey = k;
      if (!a.faceTexture || !a.faceLandmarks?.length) {
        skin.uniforms.uFaceOn.value = 0;
        return;
      }
      texLoader.load(a.faceTexture, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        tex.anisotropy = 4;
        skin.uniforms.uFaceTex.value?.dispose();
        skin.uniforms.uFaceTex.value = tex;
        worker.postMessage({ type: 'faceUV', id: ++reqId, landmarks: a.faceLandmarks! } satisfies HumanReq);
      });
    };
    const worker: Worker = new HumanWorker();
    let reqId = 0;
    let disposed = false;
    const sentKey: Record<string, string> = { main: '', ghost: '' };
    const request = (ch: 'main' | 'ghost', i: HumanInput) => {
      const k = humanKey(i);
      if (sentKey[ch] === k) return;
      sentKey[ch] = k;
      worker.postMessage({ type: 'morph', id: ++reqId, channel: ch, input: i } satisfies HumanReq);
    };

    worker.onmessage = (e: MessageEvent<HumanRes>) => {
      if (disposed) return;
      const m = e.data;
      if (m.type === 'error') {
        console.error('human worker', m.message);
        setStatus('error');
        return;
      }
      if (m.type === 'mesh') {
        for (const [k, idx] of Object.entries(m.indices)) {
          const g = new THREE.BufferGeometry();
          g.setIndex(new THREE.BufferAttribute(idx, 1));
          geoms[k] = g;
          const mesh = new THREE.Mesh(g, matFor(k));
          mesh.castShadow = k === 'body';
          mesh.receiveShadow = k === 'body';
          if (k === 'helper-l-eye' || k === 'helper-r-eye') mesh.userData.center = (k === 'helper-l-eye' ? eyeL : eyeR).uniforms.uCenter.value;
          if (k === 'helper-hair') mesh.visible = hairStyle !== 'none';
          meshes[k] = mesh;
          group.add(mesh);
        }
        // region attributes on the body: rest coords (for stable noise) + clothing mask
        const body = geoms.body;
        const rest = m.rest;
        body.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
        const nb = rest.length / 3;
        body.setAttribute('aFaceUV', new THREE.BufferAttribute(new Float32Array(nb * 2), 2));
        body.setAttribute('aFaceW', new THREE.BufferAttribute(new Float32Array(nb), 1));
        applyFace(latest.current.appearance);
        ghostGeom.setIndex(new THREE.BufferAttribute(m.indices.body, 1));
        cur = m.parts;
        applySnap(m.parts);
        updateEyes(m.eyes);
        buildRings(m.girths);
        onMeasuredRef.current?.(m.info, m.girths);
        setStatus('ready');
        if (api.current) api.current.ready = true;
        const L = latest.current;
        if (humanKey(L.input) !== sentKey.main) request('main', L.input);
        if (L.ghost) request('ghost', L.ghost);
        return;
      }
      if (m.type === 'faceUV') {
        const body = geoms.body;
        if (!body) return;
        (body.getAttribute('aFaceUV') as THREE.BufferAttribute).copyArray(m.uv).needsUpdate = true;
        (body.getAttribute('aFaceW') as THREE.BufferAttribute).copyArray(m.w).needsUpdate = true;
        skin.uniforms.uFaceOn.value = skin.uniforms.uFaceTex.value ? 1 : 0;
        return;
      }
      if (m.type === 'morph') {
        if (m.channel === 'main') {
          const from: Snap = {};
          for (const [k, g] of Object.entries(geoms)) {
            const pa = g.getAttribute('position') as THREE.BufferAttribute | undefined;
            const na = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
            if (pa && na) from[k] = { positions: new Float32Array(pa.array as Float32Array), normals: new Float32Array(na.array as Float32Array) };
          }
          anim = { from, to: m.parts, t0: performance.now(), dur: 900 };
          cur = m.parts;
          updateEyes(m.eyes);
          buildRings(m.girths);
          onMeasuredRef.current?.(m.info, m.girths);
        } else {
          setAttr(ghostGeom, m.parts.body.positions, m.parts.body.normals);
          ghostHas = true;
          ghostMesh.visible = ghostOn;
        }
      }
    };

    sentKey.main = humanKey(input);
    worker.postMessage({ type: 'init', id: ++reqId, input, baseUrl: new URL(import.meta.env.BASE_URL + 'human/', location.href).href } satisfies HumanReq);

    let viewAnim: { from: number; to: number; t0: number } | null = null;
    let zoomAnim: { fromT: number; toT: number; fromD: number; toD: number; t0: number } | null = null;
    let fitDist = 5;
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
        const Hm = latest.current.input.heightCm / 100;
        zoomAnim = {
          fromT: controls.target.y,
          toT: v === 'face' ? Hm * 0.93 : Hm * 0.5,
          fromD: camera.position.distanceTo(controls.target),
          toD: v === 'face' ? 0.85 : fitDist,
          t0: performance.now(),
        };
        const target = v === 'front' || v === 'face' ? 0 : v === 'side' ? Math.PI / 2 : Math.PI;
        const c = controls.getAzimuthalAngle();
        let to = target;
        while (to - c > Math.PI) to -= Math.PI * 2;
        while (to - c < -Math.PI) to += Math.PI * 2;
        controls.autoRotate = false;
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => (controls.autoRotate = true), 8000);
        viewAnim = { from: c, to, t0: performance.now() };
      },
      setAppearance: (a) => {
        skin.mat.color.set(a.skinTone);
        skin.uniforms.uSkin.value.set(a.skinTone);
        skin.uniforms.uFaceMean.value.set(a.faceMean ?? a.skinTone);
        eyeL.uniforms.uIris.value.set(a.eyeColor);
        eyeR.uniforms.uIris.value.set(a.eyeColor);
        hairMat.color.set(a.hairColor);
        skin.uniforms.uHair.value.set(a.hairColor);
        skin.uniforms.uHairOn.value = a.hairStyle === 'none' ? 0 : 1;
        skin.uniforms.uHairLift.value = a.hairStyle === 'short' ? 0.0045 : 0.001;
        hairStyle = a.hairStyle;
        if (geoms.body?.getAttribute('aFaceW')) applyFace(a);
      },
    };

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + 'px';
      renderer.domElement.style.height = h + 'px';
      camera.aspect = w / h;
      const Hm = latest.current.input.heightCm / 100;
      const dist = (Hm * 1.16) / 2 / Math.tan((camera.fov * Math.PI) / 360);
      const distW = 1.35 / 2 / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect;
      const d = Math.max(dist, distW);
      fitDist = d;
      const dir = camera.position.clone().sub(controls.target).normalize();
      controls.target.set(0, Hm * 0.5, 0);
      camera.position.copy(controls.target).addScaledVector(dir, d);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver((ents) => (visible = ents[0]?.isIntersecting ?? true));
    io.observe(host);
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.hidden) return;
      const now = performance.now();
      if (anim) {
        const t = Math.min(1, (now - anim.t0) / anim.dur);
        const e = easeInOut(t);
        for (const [k, to] of Object.entries(anim.to)) {
          const from = anim.from[k];
          const g = geoms[k];
          if (!from || !g) continue;
          const pa = g.getAttribute('position') as THREE.BufferAttribute;
          const na = g.getAttribute('normal') as THREE.BufferAttribute;
          const P = pa.array as Float32Array;
          const N = na.array as Float32Array;
          for (let i = 0; i < P.length; i++) {
            P[i] = from.positions[i] + (to.positions[i] - from.positions[i]) * e;
            N[i] = from.normals[i] + (to.normals[i] - from.normals[i]) * e;
          }
          pa.needsUpdate = true;
          na.needsUpdate = true;
        }
        if (t >= 1) {
          anim = null;
          for (const g of Object.values(geoms)) g.computeBoundingSphere();
        }
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
        controls.target.y = zoomAnim.fromT + (zoomAnim.toT - zoomAnim.fromT) * e;
        camera.position.copy(controls.target).addScaledVector(dir, zoomAnim.fromD + (zoomAnim.toD - zoomAnim.fromD) * e);
        if (t >= 1) zoomAnim = null;
      }
      controls.update();
      renderer.render(scene, camera);
      if (ringsOn) renderLabels();
    };
    tick();

    return () => {
      disposed = true;
      window.clearTimeout(idleTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      worker.terminate();
      controls.dispose();
      Object.values(geoms).forEach((g) => g.dispose());
      ghostGeom.dispose();
      skin.mat.dispose();
      eyeL.mat.dispose();
      eyeR.mat.dispose();
      hairMat.dispose();
      lashMat.dispose();
      ghostMat.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelEls.forEach((el) => el.remove());
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.sex, Math.round(input.heightCm)]);

  useEffect(() => {
    if (api.current?.ready) api.current.request('main', input);
  }, [humanKey(input)]);

  useEffect(() => {
    if (!api.current) return;
    if (ghost) {
      if (api.current.ready) api.current.request('ghost', ghost);
      api.current.setGhostVisible(true);
    } else api.current.setGhostVisible(false);
  }, [humanKey(ghost), status]);

  useEffect(() => {
    api.current?.setRings(!!showRings);
  }, [showRings, status]);

  useEffect(() => {
    api.current?.setAppearance(appearance);
  }, [appearance.skinTone, appearance.eyeColor, appearance.hairColor, appearance.hairStyle, appearance.faceTexture, appearance.faceLandmarks, status]);

  useEffect(() => {
    if (view) api.current?.setView(view.name);
  }, [view?.nonce]);

  return (
    <div className={`body-viewer ${className ?? ''}`}>
      <div ref={hostRef} className="body-canvas" />
      <div ref={labelsRef} className="ring-labels" />
      {status !== 'ready' && (
        <div className="body-loading">
          <div className="scanline" />
          <span>{status === 'error' ? 'Не удалось построить модель' : 'Строю модель тела…'}</span>
        </div>
      )}
    </div>
  );
}

