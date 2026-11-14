/**
 * Look-dev materials for the digital twin (three.js r187, WebGL2, mobile budget, no post-processing).
 *
 *  • createSkinMaterial      – pre-integrated-style subsurface skin on top of MeshPhysicalMaterial (custom RE_Direct)
 *  • createCapsuleField      – analytic capsule ambient occlusion shared by skin / hair / floor
 *  • createCapsuleFitter     – fits the ≤24 body capsules from the mesh itself (rest coords → current pose), no skeleton needed
 *  • createEyeMaterial       – procedural / textured iris, limbal ring, lid occlusion, cornea highlight (clearcoat)
 *  • createHairMaterial      – alpha hair cards, Kajiya–Kay diffuse + two shifted highlights (Scheuermann 2004)
 *  • createBrowLashMaterial  – cheap alpha cards for brows / lashes
 *  • createStudioEnvironment – procedural PMREM softbox studio (no HDR files)
 *  • setupStudioLights       – key (shadow) + fill + two rims, camera-relative
 *  • createStudioFloor       – shadow catcher with capsule contact occlusion
 *  • QUALITY_TIERS / STUDIO_RENDER_SETTINGS / applyStudioRenderer
 *
 * All shader patches are written against the r187 chunks (lights_physical_pars_fragment, lights_fragment_begin,
 * normal_fragment_maps, …). Every factory returns { material, uniforms, dispose } so the caller owns the lifetime.
 *
 * References actually used (see the report for details):
 *  – d'Eon & Luebke, GPU Gems 3 ch. 14 (skin specular, F0 0.028, per-channel diffusion, normal softening per channel)
 *  – Penner & Borshukov, "Pre-Integrated Skin Shading" (curvature-driven wrap, red-shifted terminator and penumbra)
 *  – UE MetaHuman skin (dual specular lobe: two roughness scales + lobe mix)
 *  – Jimenez et al. 2016, GTAO multi-bounce fit (coloured occlusion)
 *  – Barré-Brisebois & Bouchard 2011 (cheap view-dependent translucency for thin parts)
 *  – Quilez, sphere / capsule occlusion (closest-point sphere, cosine·(r/d)² form)
 *  – Scheuermann 2004, "Practical Real-Time Hair Rendering and Shading" (two shifted Kajiya–Kay lobes)
 *  – Mikkelsen 2010, "Bump Mapping Unparametrized Surfaces on the GPU" (derivative bump for micro detail)
 */
import * as THREE from 'three';

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Quality tiers and renderer settings
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export type QualityTier = 'high' | 'medium' | 'low';

export interface TierSettings {
  /** cap for renderer.setPixelRatio(Math.min(devicePixelRatio, cap)) */
  pixelRatioCap: number;
  /** key-light shadow map size (0 = no shadow map, capsule occlusion only) */
  shadowMapSize: number;
  /** PCF radius in shadow-map texels (r187: 5 Vogel taps × hardware 2×2 PCF) */
  shadowRadius: number;
  /** where the capsule occlusion loop runs for the body */
  ao: 'vertex' | 'fragment';
  /** tiling micro-detail (pores / knit) texture: 1 sample with UVs, 2 without */
  microDetail: boolean;
  /** second, sharper specular lobe also for the environment (1 extra cube sample) */
  dualLobeIBL: boolean;
  /** thin-region back-scatter (ears, fingers) */
  translucency: boolean;
  /** number of direct lights: 4 = key + fill + 2 rims, 3 = key + 2 rims (the environment is the fill) */
  lights: 3 | 4;
}

export const QUALITY_TIERS: Record<QualityTier, TierSettings> = {
  high: { pixelRatioCap: 2, shadowMapSize: 2048, shadowRadius: 5, ao: 'vertex', microDetail: true, dualLobeIBL: true, translucency: true, lights: 4 },
  medium: { pixelRatioCap: 1.75, shadowMapSize: 1024, shadowRadius: 3, ao: 'vertex', microDetail: true, dualLobeIBL: false, translucency: true, lights: 4 },
  low: { pixelRatioCap: 1.25, shadowMapSize: 512, shadowRadius: 2, ao: 'vertex', microDetail: false, dualLobeIBL: false, translucency: false, lights: 3 },
};

/** Recommended renderer set-up for the studio look. */
export const STUDIO_RENDER_SETTINGS = {
  /** WebGLRenderer constructor parameters (MSAA is required for alpha-to-coverage hair cards) */
  context: { antialias: true, alpha: true, powerPreference: 'high-performance' as const },
  outputColorSpace: THREE.SRGBColorSpace,
  /** ACES keeps skin saturated and contrasty; AgX/Neutral were compared in look-dev (see report) */
  toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping,
  toneMappingExposure: 1.0,
  /** PCFSoftShadowMap was removed in r186+; PCFShadowMap already filters with a rotated Vogel disk */
  shadowMapType: THREE.PCFShadowMap as THREE.ShadowMapType,
  /** scene.environmentIntensity for createStudioEnvironment() */
  environmentIntensity: 1.0,
  /** CSS for the element behind the (alpha) canvas: dark neutral backdrop with a soft pool of light */
  backdropCss: 'radial-gradient(120% 70% at 50% 34%, #343a44 0%, #1d2128 46%, #0b0d11 100%)',
  tiers: QUALITY_TIERS,
} as const;

export function applyStudioRenderer(renderer: THREE.WebGLRenderer, tier: QualityTier = 'high', devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) {
  const t = QUALITY_TIERS[tier];
  renderer.setPixelRatio(Math.min(devicePixelRatio, t.pixelRatioCap));
  renderer.outputColorSpace = STUDIO_RENDER_SETTINGS.outputColorSpace;
  renderer.toneMapping = STUDIO_RENDER_SETTINGS.toneMapping;
  renderer.toneMappingExposure = STUDIO_RENDER_SETTINGS.toneMappingExposure;
  renderer.shadowMap.enabled = t.shadowMapSize > 0;
  renderer.shadowMap.type = STUDIO_RENDER_SETTINGS.shadowMapType;
  return t;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Shared GLSL
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export const CAPSULE_MAX = 24;
const GROUND_CAPSULE_MAX = 8;

const GLSL_NOISE = /* glsl */ `
float skHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skHash(i), skHash(i + vec3(1,0,0)), f.x), mix(skHash(i + vec3(0,1,0)), skHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(skHash(i + vec3(0,0,1)), skHash(i + vec3(1,0,1)), f.x), mix(skHash(i + vec3(0,1,1)), skHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

/**
 * Capsule occlusion, view space. One iteration ≈ 45 scalar ALU (2 dot, 1 clamp, 1 inversesqrt, 1 sqrt, 2 div).
 * Self-occlusion is rejected by the cosine test: for the capsule a surface point belongs to, the direction to the
 * capsule axis points *into* the surface (n·d < 0), so it contributes nothing; `wrapK` only lets capsules that are
 * partly below the horizon keep a soft contribution.
 */
const GLSL_CAPSULES = /* glsl */ `
#define CAP_MAX ${CAPSULE_MAX}
uniform vec4 uCapA[CAP_MAX];   // xyz = end A (view space), w = radius
uniform vec4 uCapB[CAP_MAX];   // xyz = end B (view space), w = 1 / |B-A|^2
uniform int uCapN;
uniform vec4 uCapGround;       // view-space ground plane: xyz = up, w = offset → height = dot(p, xyz) + w
uniform vec4 uCapP;            // x = strength, y = horizon wrap, z = ground strength, w = min visibility
float capsuleVis(vec3 p, vec3 n) {
  float vis = 1.0;
  for (int i = 0; i < CAP_MAX; i++) {
    if (i >= uCapN) break;
    vec4 A = uCapA[i];
    vec4 B = uCapB[i];
    vec3 ba = B.xyz - A.xyz;
    vec3 pa = p - A.xyz;
    float h = clamp(dot(pa, ba) * B.w, 0.0, 1.0);
    vec3 d = ba * h - pa;                               // towards the closest point of the axis
    float il = inversesqrt(max(dot(d, d), 1e-8));
    float ra = min(A.w * il, 1.0);                      // sine of the angular radius
    float c = clamp((dot(n, d) * il + uCapP.y * ra) / (1.0 + uCapP.y * ra), 0.0, 1.0);
    vis *= 1.0 - min(c * ra * sqrt(ra) * uCapP.x, 1.0);  // between sphere (ra^2) and infinite cylinder (ra)
  }
  // the ground: only what faces down and is close to it loses its bounce light
  float hgt = max(dot(p, uCapGround.xyz) + uCapGround.w, 0.0);
  vis *= 1.0 - uCapP.z * clamp(0.5 - 0.5 * dot(n, uCapGround.xyz), 0.0, 1.0) * exp(-hgt * 14.0);
  return max(vis, uCapP.w);
}
`;

const GLSL_GROUND_CAPSULES = /* glsl */ `
#define GCAP_MAX ${GROUND_CAPSULE_MAX}
uniform vec4 uGCapA[GCAP_MAX];
uniform vec4 uGCapB[GCAP_MAX];
uniform int uGCapN;
float groundCapsuleVis(vec3 p, vec3 n, float strength) {
  float vis = 1.0;
  for (int i = 0; i < GCAP_MAX; i++) {
    if (i >= uGCapN) break;
    vec4 A = uGCapA[i];
    vec4 B = uGCapB[i];
    vec3 ba = B.xyz - A.xyz;
    vec3 pa = p - A.xyz;
    float h = clamp(dot(pa, ba) * B.w, 0.0, 1.0);
    vec3 d = ba * h - pa;
    float il = inversesqrt(max(dot(d, d), 1e-8));
    float ra = min(A.w * il, 1.0);
    float c = clamp(dot(n, d) * il, 0.0, 1.0);
    vis *= 1.0 - min(c * ra * ra * strength, 1.0);
  }
  return vis;
}
`;

/** Mikkelsen derivative bump, *not* normalised: heights are metres, so the relief is scale-correct at any zoom. */
const GLSL_BUMP = /* glsl */ `
vec3 skBump(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

/** Replace `#include <name>` with `#include <name>\n code` (throws when the anchor is missing → fails loudly on a three upgrade). */
function after(src: string, chunk: string, code: string) {
  const tag = `#include <${chunk}>`;
  if (!src.includes(tag)) throw new Error(`materials.ts: shader anchor <${chunk}> not found (three.js version mismatch?)`);
  return src.replace(tag, `${tag}\n${code}`);
}
function replaceChunk(src: string, chunk: string, code: string) {
  const tag = `#include <${chunk}>`;
  if (!src.includes(tag)) throw new Error(`materials.ts: shader anchor <${chunk}> not found (three.js version mismatch?)`);
  return src.replace(tag, code);
}
function beforeMain(src: string, code: string) {
  const i = src.indexOf('void main() {');
  if (i < 0) throw new Error('materials.ts: void main() not found');
  return src.slice(0, i) + code + '\n' + src.slice(i);
}

/**
 * r187 multiplies the shadow factor into directLight.color before RE_Direct is called. Skin needs it separately
 * (the penumbra is tinted, wrap lighting must not be shadow-clipped twice), so the stock chunk is inlined with the
 * shadow factor routed into the global `gShadow` (−1 = this light has no shadow map).
 */
function lightsBeginWithSeparateShadow(): string {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const re = /directLight\.color \*= (\( directLight\.visible && receiveShadow \) \?)/g;
  let n = 0;
  const out = src.replace(re, (_m, g1: string) => {
    n++;
    return `gShadow = ${g1}`;
  });
  if (n === 0) console.warn('materials.ts: shadow hook not found in lights_fragment_begin – shadows fall back to the stock path');
  return out;
}

type Uniform<T> = { value: T };
const u = <T>(value: T): Uniform<T> => ({ value });
const srgb = (c: THREE.ColorRepresentation) => new THREE.Color(c); // THREE.Color converts sRGB input to linear working space

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Capsule field (analytic ambient occlusion)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export interface CapsuleField {
  /** uniforms shared by every material that uses the field */
  uniforms: {
    uCapA: Uniform<Float32Array>;
    uCapB: Uniform<Float32Array>;
    uCapN: Uniform<number>;
    uCapGround: Uniform<THREE.Vector4>;
    uCapP: Uniform<THREE.Vector4>;
    uGCapA: Uniform<Float32Array>;
    uGCapB: Uniform<Float32Array>;
    uGCapN: Uniform<number>;
  };
  /** world-space capsules: N × 7 floats (ax, ay, az, bx, by, bz, radius), N ≤ 24 */
  setCapsules(data: Float32Array | number[], count?: number): void;
  /** world-space height of the floor (default 0) */
  setGround(y: number): void;
  /** strength 0..1.5, horizon wrap 0..1, ground strength 0..1, minimum visibility 0..1 */
  setParams(p: { strength?: number; wrap?: number; ground?: number; minVisibility?: number }): void;
  /** recompute the view-space uniforms; materials created here call it from onBeforeRender, calling it manually is optional */
  update(camera: THREE.Camera): void;
  readonly count: number;
  /** current world-space capsules (N × 7) */
  readonly world: Float32Array;
}

export function createCapsuleField(): CapsuleField {
  const world = new Float32Array(CAPSULE_MAX * 7);
  let count = 0;
  let groundY = 0;
  let dirty = true;
  let lastCam: THREE.Camera | null = null;
  const lastView = new THREE.Matrix4();
  const uniforms = {
    uCapA: u(new Float32Array(CAPSULE_MAX * 4)),
    uCapB: u(new Float32Array(CAPSULE_MAX * 4)),
    uCapN: u(0),
    uCapGround: u(new THREE.Vector4(0, 1, 0, 0)),
    uCapP: u(new THREE.Vector4(0.9, 0.25, 0.5, 0.18)),
    uGCapA: u(new Float32Array(GROUND_CAPSULE_MAX * 4)),
    uGCapB: u(new Float32Array(GROUND_CAPSULE_MAX * 4)),
    uGCapN: u(0),
  };
  const field: CapsuleField = {
    uniforms,
    world,
    get count() {
      return count;
    },
    setCapsules(data, n) {
      count = Math.min(CAPSULE_MAX, n ?? Math.floor(data.length / 7));
      for (let i = 0; i < count * 7; i++) world[i] = data[i];
      dirty = true;
    },
    setGround(y) {
      groundY = y;
      dirty = true;
    },
    setParams(p) {
      const v = uniforms.uCapP.value;
      if (p.strength !== undefined) v.x = p.strength;
      if (p.wrap !== undefined) v.y = p.wrap;
      if (p.ground !== undefined) v.z = p.ground;
      if (p.minVisibility !== undefined) v.w = p.minVisibility;
    },
    update(camera) {
      const m = camera.matrixWorldInverse;
      if (!dirty && lastCam === camera && lastView.equals(m)) return;
      dirty = false;
      lastCam = camera;
      lastView.copy(m);
      const e = m.elements;
      const A = uniforms.uCapA.value;
      const B = uniforms.uCapB.value;
      const GA = uniforms.uGCapA.value;
      const GB = uniforms.uGCapB.value;
      let g = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 7;
        const ax = world[o],
          ay = world[o + 1],
          az = world[o + 2],
          bx = world[o + 3],
          by = world[o + 4],
          bz = world[o + 5],
          r = world[o + 6];
        const vax = e[0] * ax + e[4] * ay + e[8] * az + e[12];
        const vay = e[1] * ax + e[5] * ay + e[9] * az + e[13];
        const vaz = e[2] * ax + e[6] * ay + e[10] * az + e[14];
        const vbx = e[0] * bx + e[4] * by + e[8] * bz + e[12];
        const vby = e[1] * bx + e[5] * by + e[9] * bz + e[13];
        const vbz = e[2] * bx + e[6] * by + e[10] * bz + e[14];
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2;
        const inv = l2 > 1e-10 ? 1 / l2 : 0;
        A[i * 4] = vax;
        A[i * 4 + 1] = vay;
        A[i * 4 + 2] = vaz;
        A[i * 4 + 3] = r;
        B[i * 4] = vbx;
        B[i * 4 + 1] = vby;
        B[i * 4 + 2] = vbz;
        B[i * 4 + 3] = inv;
        // capsules that come close to the floor also feed the (per-fragment) contact shadow of the floor
        if (g < GROUND_CAPSULE_MAX && Math.min(ay, by) - r - groundY < 0.3) {
          GA[g * 4] = vax;
          GA[g * 4 + 1] = vay;
          GA[g * 4 + 2] = vaz;
          GA[g * 4 + 3] = r;
          GB[g * 4] = vbx;
          GB[g * 4 + 1] = vby;
          GB[g * 4 + 2] = vbz;
          GB[g * 4 + 3] = inv;
          g++;
        }
      }
      uniforms.uCapN.value = count;
      uniforms.uGCapN.value = g;
      // world up → view space is the second column of the view matrix
      const nx = e[4],
        ny = e[5],
        nz = e[6];
      const px = e[4] * groundY + e[12],
        py = e[5] * groundY + e[13],
        pz = e[6] * groundY + e[14];
      uniforms.uCapGround.value.set(nx, ny, nz, -(nx * px + ny * py + nz * pz));
    },
  };
  return field;
}

/* ───────────── capsule fitting from the mesh (no skeleton required) ───────────── */

interface RestCapsule {
  name: string;
  a: [number, number, number];
  b: [number, number, number];
  /** nominal radius in rest space (decimetres) – used only to assign vertices */
  r: number;
  /** fitted radius multiplier */
  k: number;
}

// Rest-space (MakeHuman base mesh, decimetres, A-pose) segments; +x is the model's left side.
// Joint positions were measured from the base mesh with the MakeHuman default rig (see rnd/shading/tools/joints.cjs).
const SIDE_CAPSULES: RestCapsule[] = [
  { name: 'chest', a: [0.75, 3.2, 0.5], b: [0.85, 5.0, 0.3], r: 1.0, k: 0.92 },
  { name: 'abdomen', a: [0.6, 1.5, 0.5], b: [0.6, 3.0, 0.6], r: 0.85, k: 0.92 },
  { name: 'pelvis', a: [0.85, -0.2, 0.15], b: [0.8, 1.2, 0.25], r: 0.95, k: 0.92 },
  { name: 'shoulder', a: [1.0, 5.3, 0.3], b: [2.0, 5.0, 0.15], r: 0.6, k: 0.9 },
  { name: 'upperarm', a: [2.06, 4.76, 0.12], b: [3.13, 3.49, 0.13], r: 0.5, k: 0.95 },
  { name: 'forearm', a: [3.13, 3.49, 0.13], b: [4.31, 2.45, 1.76], r: 0.4, k: 0.95 },
  { name: 'hand', a: [4.31, 2.45, 1.76], b: [4.8, 1.45, 2.75], r: 0.3, k: 0.9 },
  { name: 'thigh', a: [1.08, -0.32, 0.23], b: [1.58, -3.7, 0.32], r: 0.8, k: 0.95 },
  { name: 'shin', a: [1.58, -3.7, 0.32], b: [2.2, -7.45, -0.01], r: 0.55, k: 0.95 },
  { name: 'foot', a: [2.2, -7.85, -0.3], b: [2.1, -7.95, 1.5], r: 0.42, k: 0.9 },
];
const REST_CAPSULES: RestCapsule[] = [
  { name: 'head', a: [0, 7.25, 0.45], b: [0, 7.85, 0.5], r: 0.9, k: 0.95 },
  { name: 'neck', a: [0, 6.0, 0.2], b: [0, 6.75, 0.4], r: 0.55, k: 0.95 },
  ...SIDE_CAPSULES.map((c) => ({ ...c, name: c.name + '.L' })),
  ...SIDE_CAPSULES.map((c) => ({ ...c, name: c.name + '.R', a: [-c.a[0], c.a[1], c.a[2]] as [number, number, number], b: [-c.b[0], c.b[1], c.b[2]] as [number, number, number] })),
];

/** Names of the capsules produced by createCapsuleFitter, in output order. */
export const BODY_CAPSULE_NAMES: readonly string[] = REST_CAPSULES.map((c) => c.name);

export interface CapsuleFitter {
  /** per-vertex owning capsule index (rest-space assignment) */
  owner: Uint8Array;
  /**
   * Fit the capsules to the current vertex positions (world / mesh space, metres). ~1 ms for 55k vertices.
   * Works for any pose because vertices are assigned in rest space and regressed against their rest parameter.
   */
  fit(positions: ArrayLike<number>, out?: Float32Array): Float32Array;
}

/**
 * @param rest rest-space coordinates of the body vertices in decimetres (the worker's `rest` array / attribute aRest)
 */
export function createCapsuleFitter(rest: ArrayLike<number>): CapsuleFitter {
  const n = Math.floor(rest.length / 3);
  const nc = REST_CAPSULES.length;
  const owner = new Uint8Array(n);
  const tParam = new Float32Array(n);
  const seg = REST_CAPSULES.map((c) => {
    const d = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
    return { c, d, il2: 1 / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) };
  });
  for (let i = 0; i < n; i++) {
    const x = rest[i * 3],
      y = rest[i * 3 + 1],
      z = rest[i * 3 + 2];
    let best = 0,
      bestD = Infinity,
      bestT = 0;
    for (let k = 0; k < nc; k++) {
      const s = seg[k];
      const px = x - s.c.a[0],
        py = y - s.c.a[1],
        pz = z - s.c.a[2];
      const t = (px * s.d[0] + py * s.d[1] + pz * s.d[2]) * s.il2;
      const tc = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - s.d[0] * tc,
        dy = py - s.d[1] * tc,
        dz = pz - s.d[2] * tc;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) - s.c.r; // signed distance to the rest capsule
      if (dist < bestD) {
        bestD = dist;
        best = k;
        bestT = t;
      }
    }
    owner[i] = best;
    tParam[i] = bestT;
  }
  // regression accumulators
  const cnt = new Float64Array(nc);
  const st = new Float64Array(nc);
  const stt = new Float64Array(nc);
  const sp = new Float64Array(nc * 3);
  const stp = new Float64Array(nc * 3);
  const rad = new Float64Array(nc);
  return {
    owner,
    fit(positions, out = new Float32Array(nc * 7)) {
      cnt.fill(0);
      st.fill(0);
      stt.fill(0);
      sp.fill(0);
      stp.fill(0);
      rad.fill(0);
      for (let i = 0; i < n; i++) {
        const k = owner[i];
        const t = tParam[i];
        const x = positions[i * 3],
          y = positions[i * 3 + 1],
          z = positions[i * 3 + 2];
        cnt[k]++;
        st[k] += t;
        stt[k] += t * t;
        sp[k * 3] += x;
        sp[k * 3 + 1] += y;
        sp[k * 3 + 2] += z;
        stp[k * 3] += t * x;
        stp[k * 3 + 1] += t * y;
        stp[k * 3 + 2] += t * z;
      }
      // position ≈ C + D·(t − t̄)  →  A = C − D·t̄, B = A + D
      for (let k = 0; k < nc; k++) {
        const m = Math.max(cnt[k], 1);
        const tm = st[k] / m;
        const vt = Math.max(stt[k] / m - tm * tm, 1e-6);
        for (let a = 0; a < 3; a++) {
          const c = sp[k * 3 + a] / m;
          const d = (stp[k * 3 + a] / m - tm * c) / vt;
          out[k * 7 + a] = c - d * tm;
          out[k * 7 + 3 + a] = c - d * tm + d;
        }
      }
      // radius = mean distance of the owned vertices to the fitted axis
      for (let i = 0; i < n; i++) {
        const k = owner[i];
        const o = k * 7;
        const ax = out[o],
          ay = out[o + 1],
          az = out[o + 2];
        const dx = out[o + 3] - ax,
          dy = out[o + 4] - ay,
          dz = out[o + 5] - az;
        const px = positions[i * 3] - ax,
          py = positions[i * 3 + 1] - ay,
          pz = positions[i * 3 + 2] - az;
        let t = (px * dx + py * dy + pz * dz) / Math.max(dx * dx + dy * dy + dz * dz, 1e-12);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        rad[k] += Math.hypot(px - dx * t, py - dy * t, pz - dz * t);
      }
      for (let k = 0; k < nc; k++) out[k * 7 + 6] = (rad[k] / Math.max(cnt[k], 1)) * REST_CAPSULES[k].k;
      return out;
    },
  };
}

/**
 * Per-vertex mean curvature magnitude (1/m) for the scatter width, as an alternative to screen-space derivatives.
 * Mean over incident edges of |Δn| / |Δp|. O(indices). Assign as attribute `aCurv` and use curvature: 'attribute'.
 */
export function computeVertexCurvature(positions: ArrayLike<number>, normals: ArrayLike<number>, index: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = Math.floor(positions.length / 3);
  const curv = out ?? new Float32Array(n);
  curv.fill(0);
  const cnt = new Uint16Array(n);
  const edge = (i: number, j: number) => {
    const dp = Math.hypot(positions[i * 3] - positions[j * 3], positions[i * 3 + 1] - positions[j * 3 + 1], positions[i * 3 + 2] - positions[j * 3 + 2]);
    if (dp < 1e-9) return;
    const dn = Math.hypot(normals[i * 3] - normals[j * 3], normals[i * 3 + 1] - normals[j * 3 + 1], normals[i * 3 + 2] - normals[j * 3 + 2]);
    const k = dn / dp;
    curv[i] += k;
    curv[j] += k;
    cnt[i]++;
    cnt[j]++;
  };
  for (let f = 0; f + 2 < index.length; f += 3) {
    edge(index[f], index[f + 1]);
    edge(index[f + 1], index[f + 2]);
    edge(index[f + 2], index[f]);
  }
  for (let i = 0; i < n; i++) if (cnt[i]) curv[i] /= cnt[i];
  return curv;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Micro-detail texture (pores / skin microrelief in R, roughness variation in G, knit in B)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Tileable 128² RGBA8 texture generated once on the CPU (~4 ms). Mip-mapping makes the relief fade to flat with
 * distance, which is what removes specular shimmering without any per-pixel fade logic.
 */
export function createSkinMicroTexture(size = 128, seed = 11): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const cells = 22; // skin "cells" per tile: with a 2.5 cm tile this is a 1.1 mm microrelief
  const fx = new Float32Array(cells * cells);
  const fy = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    fx[i] = 0.15 + 0.7 * rnd();
    fy[i] = 0.15 + 0.7 * rnd();
  }
  // tileable value noise for large-scale variation
  const NG = 8;
  const grid = new Float32Array(NG * NG);
  for (let i = 0; i < NG * NG; i++) grid[i] = rnd();
  const vnoise = (x: number, y: number) => {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    let tx = x - xi,
      ty = y - yi;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const g = (a: number, b: number) => grid[(((b % NG) + NG) % NG) * NG + (((a % NG) + NG) % NG)];
    return g(xi, yi) * (1 - tx) * (1 - ty) + g(xi + 1, yi) * tx * (1 - ty) + g(xi, yi + 1) * (1 - tx) * ty + g(xi + 1, yi + 1) * tx * ty;
  };
  const sst = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x / size) * cells,
        py = (y / size) * cells;
      const cx = Math.floor(px),
        cy = Math.floor(py);
      let f1 = 9,
        f2 = 9;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i,
            gy = cy + j;
          const id = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const d = Math.hypot(gx + fx[id] - px, gy + fy[id] - py);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      const crease = sst(0.0, 0.22, f2 - f1); // 0 in the furrows between cells, 1 on the plateaus
      const pore = 1 - sst(0.0, 0.16, f1); // small pit in the middle of some cells
      const lf = vnoise((x / size) * NG, (y / size) * NG);
      const height = Math.min(1, Math.max(0, 0.18 + 0.62 * crease - 0.3 * pore * (lf > 0.45 ? 1 : 0.3) + 0.2 * (lf - 0.5)));
      const rough = Math.min(1, Math.max(0, 0.5 + 0.35 * (0.5 - crease) + 0.5 * (lf - 0.5)));
      // knit (jersey): wales along v with a slight zig-zag, courses across
      const wales = 12,
        courses = 16;
      const kx = (x / size) * wales + 0.18 * Math.sin((y / size) * courses * Math.PI * 2);
      const kv = 0.5 + 0.5 * Math.cos(kx * Math.PI * 2);
      const kc = 0.5 + 0.5 * Math.cos((y / size) * courses * Math.PI * 2 + (Math.floor(kx) % 2) * Math.PI);
      const knit = Math.min(1, Math.max(0, 0.65 * Math.pow(kv, 0.7) + 0.35 * kc * kv));
      const o = (y * size + x) * 4;
      data[o] = Math.round(height * 255);
      data[o + 1] = Math.round(rough * 255);
      data[o + 2] = Math.round(knit * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Skin
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export interface SkinMaterialOptions {
  tier?: QualityTier;
  /** base skin tone (sRGB). With an albedo map the texture is re-toned so that its mean becomes this colour. */
  tone?: THREE.ColorRepresentation;
  /** albedo map (sRGB); the geometry needs a `uv` attribute */
  map?: THREE.Texture | null;
  /** mean colour of the albedo map (sRGB) – required for re-toning; defaults to the tone (= no re-toning) */
  texMean?: THREE.ColorRepresentation;
  /** 0 = show the map as authored, 1 = fully re-tone to `tone` */
  retone?: number;
  /** tangent-space detail normal map (muscle definition); strength is `definition` and can be changed at runtime */
  normalMap?: THREE.Texture | null;
  definition?: number;
  /** underwear mask in UV space: R = coverage, G = bands (waistband / hems), B = seams */
  maskMap?: THREE.Texture | null;
  /** when there is no maskMap: procedural briefs (+ top for `female`) from the rest coordinates */
  restMask?: boolean;
  female?: boolean;
  fabricColor?: THREE.ColorRepresentation;
  fabricBandColor?: THREE.ColorRepresentation;
  /** the geometry has `uv` (default: true when any of map / normalMap / maskMap is given) → micro detail uses UVs */
  hasUv?: boolean;
  /** the geometry has attribute aRest (vec3, rest coordinates in decimetres). Default true. */
  restAttribute?: boolean;
  /** capsule occlusion field; `ao` selects where the loop runs (default from the tier) */
  capsules?: CapsuleField | null;
  ao?: 'vertex' | 'fragment' | 'off';
  /** scatter width source: screen-space derivatives (default), attribute aCurv (1/m) or a constant */
  curvature?: 'derivative' | 'attribute' | 'constant';
  /** selfie projection hook: attributes aFaceUV (vec2) + aFaceW (float) and uniforms uFaceTex / uFaceOn / uFaceMean */
  faceProjection?: boolean;
  /** procedural scalp stubble / shadow under hair cards (rest-space hairline) */
  scalp?: { color: THREE.ColorRepresentation; amount: number } | null;
  /** share one micro texture between materials (otherwise one is created and owned by the material) */
  microTexture?: THREE.Texture;
  roughness?: number;
}

export interface SkinUniforms {
  uTone: Uniform<THREE.Color>;
  uTexMean: Uniform<THREE.Color>;
  uRetone: Uniform<number>;
  uFabric: Uniform<THREE.Color>;
  uFabricBand: Uniform<THREE.Color>;
  /** x roughness, y sheen, z knit height (m), w seam darkening */
  uFabricP: Uniform<THREE.Vector4>;
  uMask: Uniform<THREE.Texture | null>;
  uMicro: Uniform<THREE.Texture | null>;
  /** x tiles (per UV unit, or per decimetre of rest space), y relief height (m), z roughness variation, w specular cavity */
  uMicroP: Uniform<THREE.Vector4>;
  /** xyz per-channel scatter ratio, w red scatter distance (m) */
  uScatter: Uniform<THREE.Vector4>;
  /** x min wrap, y max wrap, z translucency, w constant curvature (1/m) */
  uScatterP: Uniform<THREE.Vector4>;
  /** how much each channel ignores the micro normal (R most) */
  uNormalBlend: Uniform<THREE.Vector3>;
  /** penumbra tint exponents (R bleeds furthest) */
  uShadowTint: Uniform<THREE.Vector3>;
  /** x roughness scale lobe 1, y roughness scale lobe 2, z weight of lobe 2 */
  uLobe: Uniform<THREE.Vector3>;
  uTransColor: Uniform<THREE.Color>;
  /** x capsule AO on the shadowed key, y on lights without a shadow map, z curvature for full thinness (1/m), w curvature where thinness starts */
  uAoP: Uniform<THREE.Vector4>;
  uFemale: Uniform<number>;
  uFaceTex: Uniform<THREE.Texture | null>;
  uFaceOn: Uniform<number>;
  uFaceMean: Uniform<THREE.Color>;
  uScalpColor: Uniform<THREE.Color>;
  uScalpAmt: Uniform<number>;
  /** debug view: 0 off, 1 occlusion, 2 albedo, 3 wrap width, 4 shadow */
  uDebug: Uniform<number>;
}

export interface SkinMaterial {
  material: THREE.MeshPhysicalMaterial;
  uniforms: SkinUniforms;
  capsules: CapsuleField | null;
  setTone(tone: THREE.ColorRepresentation): void;
  /** muscle-definition strength (normalScale of the detail normal map) */
  setDefinition(strength: number): void;
  setFabric(color: THREE.ColorRepresentation, band?: THREE.ColorRepresentation): void;
  /** swap textures at runtime (recompiles only when a slot goes from empty to used or back) */
  setMaps(maps: { map?: THREE.Texture | null; texMean?: THREE.ColorRepresentation; normalMap?: THREE.Texture | null; maskMap?: THREE.Texture | null }): void;
  /** selfie texture for the face projection (null switches it off) */
  setFace(tex: THREE.Texture | null, mean?: THREE.ColorRepresentation): void;
  setScalp(color: THREE.ColorRepresentation, amount: number): void;
  /** world-space capsules, N × 7 (ax ay az bx by bz r) */
  setCapsules(data: Float32Array | number[], count?: number): void;
  dispose(): void;
}

const SKIN_VERTEX_PARS = /* glsl */ `
#ifdef SKIN_REST
  attribute vec3 aRest;
  varying vec3 vRest;
  varying vec3 vObjN;
#endif
#ifdef SKIN_ZONES
  varying vec2 vZone;
  ${GLSL_NOISE}
  float skBlob(vec3 p, vec3 c, float r) { vec3 d = (p - c) / r; return exp(-dot(d, d)); }
  // blood-rich areas of the body in rest space (decimetres): x = redness, y = low-frequency mottling
  vec2 skinZones(vec3 r) {
    vec3 m = vec3(abs(r.x), r.y, r.z);
    float red = 0.0;
    red += 0.9 * skBlob(m, vec3(1.47, -3.55, 0.75), 0.55);                                  // knee caps
    red += 0.9 * skBlob(m, vec3(2.75, 3.85, -0.2), 0.45);                                   // elbows
    red += 0.55 * smoothstep(0.0, 0.6, dot(m - vec3(4.31, 2.45, 1.76), vec3(0.33, -0.67, 0.66))) * step(3.3, m.x); // hands
    red += 0.6 * (1.0 - smoothstep(-7.75, -7.3, r.y));                                      // feet
    red += 0.5 * skBlob(m, vec3(0.5, 6.93, 1.05), 0.36);                                    // cheeks
    red += 0.6 * skBlob(r, vec3(0.0, 6.93, 1.62), 0.22);                                    // nose tip
    red += 0.75 * skBlob(m, vec3(0.86, 7.2, 0.3), 0.3);                                     // ears
    red += 0.25 * skBlob(r, vec3(0.0, 6.5, 1.45), 0.3);                                     // chin
    red += 0.2 * skBlob(m, vec3(2.3, 5.0, 0.1), 0.5);                                       // shoulder caps
    float mottle = skNoise(r * 6.0) * 0.6 + skNoise(r * 17.0) * 0.4;
    return vec2(min(red, 1.0), mottle);
  }
#endif
#ifdef SKIN_FACE_PROJ
  attribute vec2 aFaceUV;
  attribute float aFaceW;
  varying vec2 vFaceUV;
  varying float vFaceW;
#endif
#ifdef SKIN_CURV_ATTR
  attribute float aCurv;
  varying float vCurv;
#endif
#ifdef SKIN_AO_VERTEX
  varying float vCapVis;
  ${GLSL_CAPSULES}
#endif
`;

const SKIN_VERTEX_BEGIN = /* glsl */ `
#ifdef SKIN_REST
  vRest = aRest;
  vObjN = objectNormal;
#endif
#ifdef SKIN_ZONES
  vZone = skinZones(aRest);
#endif
#ifdef SKIN_FACE_PROJ
  vFaceUV = aFaceUV;
  vFaceW = aFaceW;
#endif
#ifdef SKIN_CURV_ATTR
  vCurv = aCurv;
#endif
`;

const SKIN_VERTEX_PROJECT = /* glsl */ `
#ifdef SKIN_AO_VERTEX
  vCapVis = capsuleVis(mvPosition.xyz, normalize(transformedNormal));
#endif
`;

const SKIN_FRAGMENT_PARS = /* glsl */ `
uniform vec3 uTone;
uniform vec3 uTexMean;
uniform float uRetone;
uniform vec3 uFabric;
uniform vec3 uFabricBand;
uniform vec4 uFabricP;
uniform vec4 uMicroP;
uniform vec4 uScatter;
uniform vec4 uScatterP;
uniform vec3 uNormalBlend;
uniform vec3 uShadowTint;
uniform vec3 uLobe;
uniform vec3 uTransColor;
uniform vec4 uAoP;
uniform float uFemale;
uniform float uDebug;
#ifdef SKIN_REST
  varying vec3 vRest;
  varying vec3 vObjN;
#endif
#ifdef SKIN_ZONES
  varying vec2 vZone;
#endif
#ifdef SKIN_MICRO
  uniform sampler2D uMicro;
#endif
#ifdef SKIN_MASK_TEX
  uniform sampler2D uMask;
#endif
#ifdef SKIN_FACE_PROJ
  uniform sampler2D uFaceTex;
  uniform float uFaceOn;
  uniform vec3 uFaceMean;
  varying vec2 vFaceUV;
  varying float vFaceW;
#endif
#ifdef SKIN_SCALP
  uniform vec3 uScalpColor;
  uniform float uScalpAmt;
#endif
#ifdef SKIN_CURV_ATTR
  varying float vCurv;
#endif
#ifdef SKIN_AO_VERTEX
  varying float vCapVis;
#endif
#ifdef SKIN_AO_FRAGMENT
  ${GLSL_CAPSULES}
#endif
#if defined( SKIN_SCALP )
  ${GLSL_NOISE}
#endif
${GLSL_BUMP}

// shading state shared between the main body and RE_Direct_Skin
float gShadow = -1.0;      // shadow factor of the light being evaluated (−1: no shadow map)
float gCloth = 0.0;        // fabric coverage
float gAO = 1.0;           // capsule visibility
float gSpecOcc = 1.0;      // micro cavity
float gThin = 0.0;         // thin-region factor for back-scatter
vec3 gWrap = vec3(0.0);    // per-channel wrap width
vec3 gSmoothN = vec3(0.0, 0.0, 1.0);
vec3 gMicro = vec3(0.5, 0.5, 0.5);

float ssk(float a, float b, float x) { return smoothstep(a, b, x); }

#ifdef SKIN_MASK_REST
// rest-space (MakeHuman base mesh, decimetres): crotch -0.45, hips 0.1, waist 1.9, underbust 3.2, chest 3.85
float clothMaskRest(vec3 r, float female) {
  float ax = abs(r.x);
  float legCut = -1.25 + max(0.0, ax - 1.0) * 0.25;
  float top = r.z < 0.3 ? 1.1 : 0.95;
  float m = ssk(legCut - 0.03, legCut + 0.03, r.y) * (1.0 - ssk(top - 0.03, top + 0.03, r.y)) * (1.0 - ssk(2.0, 2.08, ax));
  if (female > 0.5) {
    float t1 = r.z > 0.8 ? 4.45 : 4.15;
    float tm = ssk(2.97, 3.03, r.y) * (1.0 - ssk(t1 - 0.03, t1 + 0.03, r.y)) * (1.0 - ssk(1.86, 1.95, ax));
    m = max(m, tm);
  }
  return m;
}
// waistband / hems for the procedural briefs
float clothBandRest(vec3 r, float female) {
  float ax = abs(r.x);
  float legCut = -1.25 + max(0.0, ax - 1.0) * 0.25;
  float top = r.z < 0.3 ? 1.1 : 0.95;
  float b = (1.0 - ssk(0.0, 0.16, abs(r.y - (top - 0.1)))) + (1.0 - ssk(0.0, 0.07, abs(r.y - (legCut + 0.07))));
  if (female > 0.5) {
    float t1 = r.z > 0.8 ? 4.45 : 4.15;
    b += (1.0 - ssk(0.0, 0.1, abs(r.y - 3.08))) + (1.0 - ssk(0.0, 0.06, abs(r.y - (t1 - 0.06))));
  }
  return clamp(b, 0.0, 1.0);
}
#endif

#ifdef SKIN_SCALP
float scalpMask(vec3 r) {
  if (r.y < 6.6) return 0.0;
  vec2 d = vec2(r.x, r.z - 0.6);
  float c = d.y / max(length(d), 1e-4);
  float hy = c > 0.0 ? mix(7.33, 7.8, pow(c, 1.4)) : mix(7.33, 6.92, pow(-c, 0.8));
  float m = ssk(hy - 0.04, hy + 0.1, r.y + (skNoise(r * 25.0) - 0.5) * 0.07);
  float ear = 1.0 - ssk(0.74, 0.8, abs(r.x));
  m *= mix(1.0, ear, 1.0 - ssk(7.45, 7.6, r.y));
  return m;
}
#endif

#if defined( SKIN_MICRO ) && ! defined( SKIN_MICRO_UV )
// biplanar projection of the tiling micro texture from rest space (2 samples, explicit gradients)
vec3 skinBiplanar(vec3 p, vec3 nrm) {
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  vec3 n = abs(nrm);
  ivec3 ma = (n.x > n.y && n.x > n.z) ? ivec3(0, 1, 2) : (n.y > n.z) ? ivec3(1, 2, 0) : ivec3(2, 0, 1);
  ivec3 mi = (n.x < n.y && n.x < n.z) ? ivec3(0, 1, 2) : (n.y < n.z) ? ivec3(1, 2, 0) : ivec3(2, 0, 1);
  ivec3 me = ivec3(3) - mi - ma;
  vec3 x = textureGrad(uMicro, vec2(p[ma.y], p[ma.z]), vec2(dpdx[ma.y], dpdx[ma.z]), vec2(dpdy[ma.y], dpdy[ma.z])).rgb;
  vec3 y = textureGrad(uMicro, vec2(p[me.y], p[me.z]), vec2(dpdx[me.y], dpdx[me.z]), vec2(dpdy[me.y], dpdy[me.z])).rgb;
  vec2 w = clamp((vec2(n[ma.x], n[me.x]) - 0.5773) / (1.0 - 0.5773), 0.0, 1.0);
  return (x * w.x + y * w.y) / max(w.x + w.y, 1e-4);
}
#endif

// Jimenez et al. 2016: multi-bounce approximation – occlusion on bright albedo is lighter and takes its hue
vec3 skinAoColor(float ao, vec3 albedo) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  return max(vec3(ao), ((ao * a + b) * ao + c) * ao);
}
`;

/** Custom direct lighting. Must follow <lights_physical_pars_fragment> (uses its BRDF helpers and PhysicalMaterial). */
const SKIN_RE_DIRECT = /* glsl */ `
void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 L = directLight.direction;
  // shadow factor of this light (separated from the light colour, see lightsBeginWithSeparateShadow)
  float sh = gShadow;
  float occ = mix(1.0, gAO, sh < 0.0 ? uAoP.y : uAoP.x);
  sh = sh < 0.0 ? 1.0 : sh;
  gShadow = -1.0;

  float skinK = 1.0 - gCloth;
  float ndl = dot(geometryNormal, L);
  float ndlSmooth = dot(gSmoothN, L);

  // ── diffuse: curvature-driven, energy-normalised wrap per colour channel (pre-integrated-skin look).
  //    Red scatters furthest → sees the smoothest normal and the widest wrap → red-shifted terminator.
  vec3 nl3 = mix(vec3(ndl), vec3(ndlSmooth), uNormalBlend * skinK);
  vec3 w = gWrap;
  vec3 wrapped = pow(saturate((nl3 + w) / (1.0 + w)), 1.0 + w) * (2.0 + w) / (2.0 * (1.0 + w));
  // penumbra: red bleeds into the shadow edge (Penner: shadow scattering)
  vec3 sh3 = pow(vec3(sh), vec3(1.0) - uShadowTint * skinK);

  vec3 halfDir = normalize(L + geometryViewDir);
  float dotVH = saturate(dot(geometryViewDir, halfDir));
  vec3 F = F_Schlick(material.specularColor, material.specularF90, dotVH);
  vec3 radiance = directLight.color * occ;
  reflectedLight.directDiffuse += radiance * sh3 * wrapped * BRDF_Lambert(material.diffuseContribution) * (1.0 - F);

  // ── specular: two GGX lobes sharing visibility and Fresnel (broad base + sharper "oily" lobe)
  float dotNL = saturate(ndl);
  float dotNV = saturate(dot(geometryNormal, geometryViewDir));
  float dotNH = saturate(dot(geometryNormal, halfDir));
  float r1 = clamp(material.roughness * mix(1.0, uLobe.x, skinK), 0.045, 1.0);
  float r2 = clamp(material.roughness * uLobe.y, 0.045, 1.0);
  float a1 = r1 * r1;
  float D = mix(D_GGX(a1, dotNH), D_GGX(r2 * r2, dotNH), uLobe.z * skinK);
  float Vis = V_GGX_SmithCorrelated(a1, dotNL, dotNV);
  reflectedLight.directSpecular += radiance * (sh * dotNL * gSpecOcc) * F * (Vis * D) * material.multiScatteringCompensation;

  // ── fabric: soft asperity sheen at grazing angles (cheap stand-in for a Charlie lobe)
  float fz = 1.0 - dotNV;
  reflectedLight.directSpecular += radiance * (sh * dotNL * gCloth * uFabricP.y * fz * fz * fz * fz) * material.diffuseContribution;

  #ifdef SKIN_TRANSLUCENCY
    // ── thin parts lit from behind (ears, fingers, nostrils): view-dependent back-scatter, not shadow-mapped
    vec3 Lt = normalize(L + gSmoothN * 0.4);
    float bt = pow(saturate(dot(geometryViewDir, -Lt)), 3.0) + 0.3 * saturate(-ndlSmooth);
    reflectedLight.directDiffuse += directLight.color * uTransColor * material.diffuseContribution * (bt * gThin * skinK * uScatterP.z * RECIPROCAL_PI) * occ;
  #endif
}
#undef RE_Direct
#define RE_Direct RE_Direct_Skin
`;

const SKIN_ALBEDO = /* glsl */ `
{
  #ifdef SKIN_MICRO
    #ifdef SKIN_MICRO_UV
      gMicro = texture2D(uMicro, vUv * uMicroP.x).rgb;
    #else
      gMicro = skinBiplanar(vRest * uMicroP.x, vObjN);
    #endif
  #endif

  #ifdef USE_MAP
    // diffuseColor.rgb = material.color (white) × albedo texel; re-tone by the ratio tone / texture mean
    vec3 alb = diffuseColor.rgb * mix(vec3(1.0), uTone / max(uTexMean, vec3(0.02)), uRetone);
  #else
    vec3 alb = uTone;
    #ifdef SKIN_ZONES
      alb *= 0.93 + 0.14 * vZone.y;                                         // mottling
      alb = mix(alb, alb * vec3(1.10, 0.80, 0.76), vZone.x * 0.5);          // blood-rich areas
      float lips = vRest.z > 1.3 ? 1.0 - ssk(0.75, 1.05, length(vec2(vRest.x / 0.27, (vRest.y - 6.53) / 0.085))) : 0.0;
      float areola = vRest.z > 1.2 ? 1.0 - ssk(0.07, 0.13, length(vec2(abs(vRest.x) - 0.78, vRest.y - 3.86))) : 0.0;
      alb = mix(alb, alb * vec3(0.92, 0.56, 0.54), lips * 0.6);
      alb = mix(alb, alb * vec3(0.78, 0.55, 0.50), areola * 0.55);
    #endif
  #endif
  alb *= 0.97 + 0.06 * gMicro.g;                                            // fine pigment grain

  // ═══════════════════ SELFIE FACE ALBEDO HOOK ═══════════════════
  // 'alb' is the linear skin albedo at this point. Override or blend it here for a photo-projected face.
  // The stock implementation transfers the *relative* detail of the selfie (texel / mean) onto the body tone.
  #ifdef SKIN_FACE_PROJ
  {
    vec3 fc = texture2D(uFaceTex, vFaceUV).rgb;
    float fw = clamp(vFaceW * uFaceOn, 0.0, 1.0);
    vec3 rel = pow(max(fc, vec3(1e-4)) / max(uFaceMean, vec3(1e-4)), vec3(0.6));
    alb = mix(alb, uTone * clamp(rel, vec3(0.08), vec3(1.6)), fw * 0.88);
  }
  #endif
  // ═══════════════════ END SELFIE FACE ALBEDO HOOK ═══════════════

  #ifdef SKIN_SCALP
    alb = mix(alb, uScalpColor * (0.55 + 0.6 * gMicro.g), scalpMask(vRest) * uScalpAmt);
  #endif

  // fabric (underwear): coverage, bands, seams
  float band = 0.0;
  float seam = 0.0;
  float edge = 0.0;
  #ifdef SKIN_MASK_TEX
    vec3 mk = texture2D(uMask, vUv).rgb;
    gCloth = ssk(0.4, 0.6, mk.r);
    band = mk.g;
    seam = mk.b;
    edge = ssk(0.02, 0.4, mk.r) * (1.0 - gCloth);                           // contact shadow next to the hem
  #elif defined( SKIN_MASK_REST )
    gCloth = clothMaskRest(vRest, uFemale);
    band = clothBandRest(vRest, uFemale) * gCloth;
  #endif
  vec3 fabric = mix(uFabric, uFabricBand, band) * (1.0 - uFabricP.w * seam) * (0.9 + 0.2 * gMicro.b);
  alb = mix(alb * (1.0 - 0.3 * edge), fabric, gCloth);
  diffuseColor.rgb = alb;
}
`;

const SKIN_ROUGHNESS = /* glsl */ `
{
  roughnessFactor += (gMicro.g - 0.5) * uMicroP.z;
  #ifdef SKIN_ZONES
    #ifndef USE_MAP
      roughnessFactor *= 1.0 - 0.3 * (vRest.z > 1.3 ? 1.0 - ssk(0.75, 1.05, length(vec2(vRest.x / 0.27, (vRest.y - 6.53) / 0.085))) : 0.0);
    #endif
  #endif
  roughnessFactor = clamp(mix(roughnessFactor, uFabricP.x, gCloth), 0.08, 1.0);
}
`;

const SKIN_NORMAL = /* glsl */ `
gSmoothN = normal;   // includes the muscle-definition normal map, excludes the sub-millimetre relief below
#ifdef SKIN_MICRO
{
  float hgt = mix(gMicro.r * uMicroP.y, gMicro.b * uFabricP.z, gCloth);
  normal = skBump(-vViewPosition, normal, vec2(dFdx(hgt), dFdy(hgt)), faceDirection);
}
#endif
`;

const SKIN_MATERIAL_SETUP = /* glsl */ `
{
  float skinK = 1.0 - gCloth;
  // fabric is a plain dielectric with weak specular; skin keeps F0 = 0.028 (ior 1.4)
  material.specularColor = mix(vec3(0.02), material.specularColor, skinK);
  material.specularColorBlended = material.specularColor;

  #if defined( SKIN_AO_FRAGMENT )
    gAO = capsuleVis(-vViewPosition, nonPerturbedNormal);
  #elif defined( SKIN_AO_VERTEX )
    gAO = vCapVis;
  #endif
  gSpecOcc = mix(1.0, clamp(gMicro.r * 1.5 + 0.1, 0.0, 1.0), uMicroP.w * skinK);

  #if defined( SKIN_CURV_ATTR )
    float curv = vCurv;
  #elif defined( SKIN_CURV_DERIV )
    float curv = length(fwidth(nonPerturbedNormal)) / max(length(fwidth(vViewPosition)), 1e-6);
  #else
    float curv = uScatterP.w;
  #endif
  // wrap ≈ scatter distance / radius of curvature, clamped; green and blue scatter less than red
  gWrap = clamp(uScatter.w * curv, uScatterP.x, uScatterP.y) * uScatter.xyz * skinK;
  gThin = smoothstep(uAoP.w, uAoP.z, curv);
}
`;

const SKIN_IBL_LOBE2 = /* glsl */ `
#if defined( SKIN_DUAL_IBL ) && defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance = mix(radiance, getIBLRadiance(geometryViewDir, geometryNormal, clamp(material.roughness * uLobe.y, 0.045, 1.0)), uLobe.z * (1.0 - gCloth));
#endif
`;

const SKIN_AO_APPLY = /* glsl */ `
{
  reflectedLight.indirectDiffuse *= skinAoColor(gAO, material.diffuseColor);
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), gAO, material.roughness) * gSpecOcc;
}
`;

const SKIN_DEBUG = /* glsl */ `
if (uDebug > 0.5) {
  vec3 dbg = vec3(gAO);
  if (uDebug > 1.5) dbg = diffuseColor.rgb;
  if (uDebug > 2.5) dbg = gWrap * 2.0;
  if (uDebug > 3.5) dbg = vec3(gThin, gCloth, gSpecOcc);
  outgoingLight = dbg;
}
`;

export function createSkinMaterial(opts: SkinMaterialOptions = {}): SkinMaterial {
  const tier = QUALITY_TIERS[opts.tier ?? 'high'];
  const capsules = opts.capsules ?? null;
  const ownsMicro = tier.microDetail && !opts.microTexture;
  const micro = tier.microDetail ? (opts.microTexture ?? createSkinMicroTexture()) : null;
  const restAttr = opts.restAttribute !== false;
  const tone = srgb(opts.tone ?? '#c9906f');

  const uniforms: SkinUniforms = {
    uTone: u(tone),
    uTexMean: u(srgb(opts.texMean ?? opts.tone ?? '#c9906f')),
    uRetone: u(opts.retone ?? 1),
    uFabric: u(srgb(opts.fabricColor ?? '#20242c')),
    uFabricBand: u(srgb(opts.fabricBandColor ?? '#2c313b')),
    uFabricP: u(new THREE.Vector4(0.82, 0.5, 0.00018, 0.4)),
    uMask: u(opts.maskMap ?? null),
    uMicro: u(micro),
    uMicroP: u(new THREE.Vector4(4, 0.00011, 0.1, 0.5)),
    uScatter: u(new THREE.Vector4(1.0, 0.42, 0.24, 0.0042)),
    uScatterP: u(new THREE.Vector4(0.08, 0.6, 1.0, 25)),
    uNormalBlend: u(new THREE.Vector3(0.75, 0.4, 0.2)),
    uShadowTint: u(new THREE.Vector3(0.5, 0.18, 0.08)),
    uLobe: u(new THREE.Vector3(1.12, 0.6, 0.22)),
    uTransColor: u(srgb('#ff3b1e')),
    uAoP: u(new THREE.Vector4(0.45, 0.9, 170, 45)),
    uFemale: u(opts.female ? 1 : 0),
    uFaceTex: u<THREE.Texture | null>(null),
    uFaceOn: u(0),
    uFaceMean: u(tone.clone()),
    uScalpColor: u(srgb(opts.scalp?.color ?? '#2b2119')),
    uScalpAmt: u(opts.scalp?.amount ?? 0),
    uDebug: u(0),
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: opts.map ?? null,
    normalMap: opts.normalMap ?? null,
    roughness: opts.roughness ?? 0.52,
    metalness: 0,
    ior: 1.4, // F0 = ((1.4 − 1) / (1.4 + 1))² = 0.028, the measured value for skin
    specularIntensity: 1,
    envMapIntensity: 1,
  });
  const def = opts.definition ?? 1;
  mat.normalScale.set(def, def);

  const state = {
    mask: !!opts.maskMap,
    hasUv: opts.hasUv ?? !!(opts.map || opts.normalMap || opts.maskMap),
  };
  const aoMode = capsules ? (opts.ao ?? tier.ao) : 'off';
  const curvature = opts.curvature ?? 'derivative';

  const syncDefines = () => {
    const d: Record<string, string> = { STANDARD: '', PHYSICAL: '' };
    if (state.hasUv) d.USE_UV = '';
    if (restAttr) d.SKIN_REST = '';
    if (restAttr) d.SKIN_ZONES = '';
    if (micro && (state.hasUv || restAttr)) {
      d.SKIN_MICRO = '';
      if (state.hasUv) d.SKIN_MICRO_UV = '';
    }
    if (state.mask && state.hasUv) d.SKIN_MASK_TEX = '';
    else if (opts.restMask !== false && restAttr) d.SKIN_MASK_REST = '';
    if (opts.faceProjection) d.SKIN_FACE_PROJ = '';
    if (opts.scalp && restAttr) d.SKIN_SCALP = '';
    if (aoMode === 'vertex') d.SKIN_AO_VERTEX = '';
    if (aoMode === 'fragment') d.SKIN_AO_FRAGMENT = '';
    if (curvature === 'attribute') d.SKIN_CURV_ATTR = '';
    if (curvature === 'derivative') d.SKIN_CURV_DERIV = '';
    if (tier.dualLobeIBL) d.SKIN_DUAL_IBL = '';
    if (tier.translucency) d.SKIN_TRANSLUCENCY = '';
    mat.defines = d;
    mat.needsUpdate = true;
  };
  syncDefines();
  // micro tiling: per UV unit when UVs exist, else per decimetre of rest space (2.5 cm tile)
  uniforms.uMicroP.value.x = state.hasUv ? 70 : 4;

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    if (capsules && aoMode !== 'off') Object.assign(sh.uniforms, capsules.uniforms);

    let vs = sh.vertexShader;
    vs = beforeMain(vs, SKIN_VERTEX_PARS);
    vs = after(vs, 'begin_vertex', SKIN_VERTEX_BEGIN);
    vs = after(vs, 'project_vertex', SKIN_VERTEX_PROJECT);
    sh.vertexShader = vs;

    let fs = sh.fragmentShader;
    fs = after(fs, 'lights_physical_pars_fragment', SKIN_FRAGMENT_PARS + SKIN_RE_DIRECT);
    fs = after(fs, 'color_fragment', SKIN_ALBEDO);
    fs = after(fs, 'roughnessmap_fragment', SKIN_ROUGHNESS);
    fs = after(fs, 'normal_fragment_maps', SKIN_NORMAL);
    fs = after(fs, 'lights_physical_fragment', SKIN_MATERIAL_SETUP);
    fs = replaceChunk(fs, 'lights_fragment_begin', lightsBeginWithSeparateShadow());
    fs = after(fs, 'lights_fragment_maps', SKIN_IBL_LOBE2);
    fs = after(fs, 'aomap_fragment', SKIN_AO_APPLY);
    fs = replaceChunk(fs, 'opaque_fragment', SKIN_DEBUG + '\n#include <opaque_fragment>');
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'bt-skin-1';
  if (capsules && aoMode !== 'off') mat.onBeforeRender = (_r, _s, camera) => capsules.update(camera);

  return {
    material: mat,
    uniforms,
    capsules,
    setTone(c) {
      uniforms.uTone.value.set(c);
    },
    setDefinition(s) {
      mat.normalScale.set(s, s);
    },
    setFabric(c, band) {
      uniforms.uFabric.value.set(c);
      if (band !== undefined) uniforms.uFabricBand.value.set(band);
      else uniforms.uFabricBand.value.set(c).lerp(new THREE.Color(1, 1, 1), 0.06);
    },
    setMaps(m) {
      const before = JSON.stringify([!!mat.map, !!mat.normalMap, state.mask, state.hasUv]);
      if (m.map !== undefined) mat.map = m.map;
      if (m.normalMap !== undefined) mat.normalMap = m.normalMap;
      if (m.maskMap !== undefined) {
        uniforms.uMask.value = m.maskMap;
        state.mask = !!m.maskMap;
      }
      if (m.texMean !== undefined) uniforms.uTexMean.value.set(m.texMean);
      if (mat.map || mat.normalMap || state.mask) state.hasUv = true;
      if (before !== JSON.stringify([!!mat.map, !!mat.normalMap, state.mask, state.hasUv])) {
        uniforms.uMicroP.value.x = state.hasUv ? 70 : 4;
        syncDefines();
      }
    },
    setFace(tex, mean) {
      uniforms.uFaceTex.value = tex;
      uniforms.uFaceOn.value = tex ? 1 : 0;
      if (mean !== undefined) uniforms.uFaceMean.value.set(mean);
    },
    setScalp(c, amount) {
      uniforms.uScalpColor.value.set(c);
      uniforms.uScalpAmt.value = amount;
    },
    setCapsules(data, count) {
      capsules?.setCapsules(data, count);
    },
    dispose() {
      mat.dispose();
      if (ownsMicro) micro?.dispose();
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Eyes
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export interface EyeMaterialOptions {
  /** iris colour for the procedural iris (sRGB) */
  irisColor?: THREE.ColorRepresentation;
  /** optional eye texture (sRGB, needs `uv`); when given it replaces the procedural iris + sclera colours */
  map?: THREE.Texture | null;
  scleraColor?: THREE.ColorRepresentation;
  /** sine of the iris angular radius (iris radius / eyeball radius ≈ 5.9 mm / 12 mm) */
  irisSize?: number;
  /** pupil radius as a fraction of the iris radius */
  pupil?: number;
}

export interface EyeUniforms {
  uEyeC: Uniform<THREE.Vector3>;
  uEyeF: Uniform<THREE.Vector3>;
  uEyeU: Uniform<THREE.Vector3>;
  uIris: Uniform<THREE.Color>;
  uSclera: Uniform<THREE.Color>;
  /** x iris size (sine), y pupil fraction, z limbal darkening, w parallax depth */
  uEyeP: Uniform<THREE.Vector4>;
  /** x upper lid line, y lower lid line, z corner distance (all in sine units of the eyeball), w occlusion strength */
  uLid: Uniform<THREE.Vector4>;
  /** x iris concavity, y cornea bulge, z sclera flattening (fake scattering), w unused */
  uEyeN: Uniform<THREE.Vector4>;
}

export interface EyeMaterial {
  material: THREE.MeshPhysicalMaterial;
  uniforms: EyeUniforms;
  /** eyeball centre and gaze direction in *world* space (the iris is centred on the gaze axis) */
  setEye(center: THREE.Vector3, forward?: THREE.Vector3, up?: THREE.Vector3): void;
  setIrisColor(c: THREE.ColorRepresentation): void;
  dispose(): void;
}

const EYE_FRAGMENT_PARS = /* glsl */ `
uniform vec3 uEyeC;
uniform vec3 uEyeF;
uniform vec3 uEyeU;
uniform vec3 uIris;
uniform vec3 uSclera;
uniform vec4 uEyeP;
uniform vec4 uLid;
uniform vec4 uEyeN;
varying vec3 vEyeW;
float gEyeAO = 1.0;
float gIris = 0.0;
vec3 gEyeRadial = vec3(0.0);   // world-space unit vector from the gaze axis outwards
vec3 gEyeDir = vec3(0.0, 0.0, 1.0);
float eyeHash(float n) { return fract(sin(n) * 43758.5453); }
float eyeNoise(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(eyeHash(i), eyeHash(i + 1.0), f); }
`;

const EYE_COLOR = /* glsl */ `
{
  vec3 d = normalize(vEyeW - uEyeC);
  gEyeDir = d;
  vec3 rightV = normalize(cross(uEyeU, uEyeF));
  vec3 upV = cross(uEyeF, rightV);
  vec2 q = vec2(dot(d, rightV), dot(d, upV));           // position on the eyeball in sine units
  float front = step(0.0, dot(d, uEyeF));
  float sinA = length(q);
  gEyeRadial = (rightV * q.x + upV * q.y) / max(sinA, 1e-4);

  // cornea refraction (parallax): the iris disc sits below the surface, so it shifts away from the viewer
  vec3 Vw = normalize(cameraPosition - vEyeW);
  vec2 vt = vec2(dot(Vw, rightV), dot(Vw, upV));
  float rr0 = sinA / uEyeP.x;
  vec2 qi = q - vt * uEyeP.w * (1.0 - clamp(rr0 * rr0, 0.0, 1.0)) / max(dot(Vw, uEyeF), 0.35);
  float rr = length(qi) / uEyeP.x;                      // 0 centre … 1 limbus
  gIris = (1.0 - smoothstep(0.9, 1.06, rr0)) * front;

  #ifdef USE_MAP
    vec3 col = diffuseColor.rgb;
  #else
    // sclera: off-white, warmer and slightly darker towards the corners
    float per = smoothstep(uEyeP.x * 1.1, 0.95, sinA);
    vec3 sclera = mix(uSclera, uSclera * vec3(0.94, 0.80, 0.77), per * 0.65);
    // iris: radial fibres, lighter collarette, dark limbal ring, soft pupil edge
    float th = atan(qi.y, qi.x);
    float fib = 0.55 * eyeNoise(th * 14.0 + 3.0) + 0.45 * eyeNoise(th * 43.0 + rr * 2.0);
    float crypt = eyeNoise(th * 7.0 + 11.0) * eyeNoise(rr * 9.0 + th * 3.0);
    vec3 iris = uIris * (0.5 + 0.95 * fib) * (1.0 - 0.35 * crypt);
    float pup = uEyeP.y;
    float coll = exp(-pow((rr - pup * 1.55) / 0.13, 2.0));
    iris = mix(iris, (uIris * 1.5 + vec3(0.10, 0.07, 0.03)) * (0.7 + 0.5 * fib), coll * 0.55);
    iris *= 1.0 - uEyeP.z * smoothstep(0.55, 1.0, rr);                       // limbal ring
    iris = mix(vec3(0.003), iris, smoothstep(pup - 0.03, pup + 0.05, rr));  // pupil
    float irisM = (1.0 - smoothstep(0.9, 1.06, rr)) * front;
    vec3 col = mix(sclera, iris, irisM);
    // soft dark ring where the sclera meets the cornea
    col *= 1.0 - 0.35 * front * (1.0 - smoothstep(0.0, 0.14, abs(rr0 - 1.02)));
  #endif

  // lids: the upper lid (and its lashes) shadows the eyeball, corners and lower lid occlude softly
  float top = smoothstep(uLid.x - 0.42, uLid.x + 0.05, q.y);
  float bot = smoothstep(-uLid.y + 0.3, -uLid.y - 0.05, q.y);
  float side = smoothstep(uLid.z - 0.45, uLid.z + 0.05, abs(q.x));
  gEyeAO = 1.0 - uLid.w * clamp(0.85 * top + 0.4 * bot + 0.55 * side, 0.0, 1.0);
  gEyeAO *= mix(1.0, 0.25, 1.0 - front);
  // occluded sclera turns warm (light that reaches it went through lid tissue)
  col = mix(col * vec3(1.0, 0.86, 0.82), col, gEyeAO);
  diffuseColor.rgb = col;
}
`;

const EYE_NORMAL = /* glsl */ `
{
  // base layer: the iris is a shallow bowl (lit on the side opposite to the light), the sclera scatters → flatter normal
  float sinA = clamp(length(cross(gEyeDir, uEyeF)), 0.0, 1.0);
  float cosA = dot(gEyeDir, uEyeF);
  vec3 nIris = normalize(uEyeF * max(cosA, 0.2) - gEyeRadial * sinA * uEyeN.x);
  vec3 nSclera = normalize(mix(gEyeDir, uEyeF, uEyeN.z));
  vec3 nW = mix(nSclera, nIris, gIris);
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;

const EYE_CLEARCOAT_NORMAL = /* glsl */ `
#ifdef USE_CLEARCOAT
{
  // cornea: smaller radius of curvature than the eyeball → the wet highlight travels faster across the iris
  float sinA = clamp(length(cross(gEyeDir, uEyeF)), 0.0, 1.0);
  vec3 nC = normalize(gEyeDir + gEyeRadial * sinA * uEyeN.y * gIris);
  clearcoatNormal = normalize((viewMatrix * vec4(nC, 0.0)).xyz);
}
#endif
`;

const EYE_AO_APPLY = /* glsl */ `
{
  reflectedLight.directDiffuse *= gEyeAO;
  reflectedLight.indirectDiffuse *= gEyeAO;
  reflectedLight.directSpecular *= gEyeAO;
  reflectedLight.indirectSpecular *= gEyeAO;
  #ifdef USE_CLEARCOAT
    clearcoatSpecularIndirect *= mix(1.0, gEyeAO, 0.85);
    clearcoatSpecularDirect *= mix(1.0, gEyeAO, 0.6);
  #endif
}
`;

export function createEyeMaterial(opts: EyeMaterialOptions = {}): EyeMaterial {
  const uniforms: EyeUniforms = {
    uEyeC: u(new THREE.Vector3()),
    uEyeF: u(new THREE.Vector3(0, 0, 1)),
    uEyeU: u(new THREE.Vector3(0, 1, 0)),
    uIris: u(srgb(opts.irisColor ?? '#5b4632')),
    uSclera: u(srgb(opts.scleraColor ?? '#e9e1d9')),
    uEyeP: u(new THREE.Vector4(opts.irisSize ?? 0.5, opts.pupil ?? 0.36, 0.75, 0.16)),
    uLid: u(new THREE.Vector4(0.36, 0.5, 0.82, 0.8)),
    uEyeN: u(new THREE.Vector4(0.85, 0.7, 0.35, 0)),
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: opts.map ?? null,
    roughness: 0.42,
    metalness: 0,
    ior: 1.376, // cornea / tear film
    specularIntensity: 0.6,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    let vs = sh.vertexShader;
    vs = beforeMain(vs, 'varying vec3 vEyeW;');
    vs = after(vs, 'begin_vertex', 'vEyeW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.vertexShader = vs;
    let fs = sh.fragmentShader;
    fs = beforeMain(fs, EYE_FRAGMENT_PARS);
    fs = after(fs, 'color_fragment', EYE_COLOR);
    fs = after(fs, 'normal_fragment_maps', EYE_NORMAL);
    fs = after(fs, 'clearcoat_normal_fragment_maps', EYE_CLEARCOAT_NORMAL);
    fs = after(fs, 'aomap_fragment', EYE_AO_APPLY);
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'bt-eye-1';
  return {
    material: mat,
    uniforms,
    setEye(center, forward, up) {
      uniforms.uEyeC.value.copy(center);
      if (forward) uniforms.uEyeF.value.copy(forward).normalize();
      if (up) uniforms.uEyeU.value.copy(up).normalize();
    },
    setIrisColor(c) {
      uniforms.uIris.value.set(c);
    },
    dispose() {
      mat.dispose();
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Hair cards
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

export interface HairMaterialOptions {
  /** RGBA strand texture (sRGB); alpha = coverage. Without a map the cards are opaque. */
  map?: THREE.Texture | null;
  /** base hair colour (sRGB); the texture only contributes its relative luminance */
  color?: THREE.ColorRepresentation;
  /** mean luminance of the strand texture (linear), used to normalise the tint. Default 0.25. */
  texLuminance?: number;
  /** MSAA available (renderer created with antialias: true) → alpha-to-coverage; otherwise a hard alpha test */
  msaa?: boolean;
  alphaTest?: number;
  /** which UV axis runs along the strands when there is no aStrandDir attribute */
  strandAxis?: 'u' | 'v';
  /** geometry carries attribute aStrandDir (vec3, object space, root → tip) */
  strandAttribute?: boolean;
  /** UV coordinate along the strand at the root (0 or 1) for root darkening; undefined = off */
  rootAt?: 0 | 1;
  capsules?: CapsuleField | null;
}

export interface HairUniforms {
  uHairColor: Uniform<THREE.Color>;
  /** x texture luminance normalisation, y texture contrast (0 flat … 1 as authored), z root darkening, w root length (uv) */
  uHairP: Uniform<THREE.Vector4>;
  /** x primary shift, y secondary shift, z per-strand shift noise, w alpha boost per mip */
  uHairShift: Uniform<THREE.Vector4>;
  /** x primary exponent, y secondary exponent, z primary strength, w secondary strength */
  uHairSpec: Uniform<THREE.Vector4>;
  /** x diffuse wrap, y environment specular scale, z capsule AO on direct light, w unused */
  uHairLit: Uniform<THREE.Vector4>;
}

export interface HairMaterial {
  material: THREE.MeshStandardMaterial;
  /** assign to mesh.customDepthMaterial so that the cards cast alpha-tested shadows */
  depthMaterial: THREE.MeshDepthMaterial;
  uniforms: HairUniforms;
  setColor(c: THREE.ColorRepresentation): void;
  dispose(): void;
}

const HAIR_FRAGMENT_PARS = (strandAttr: boolean, alongV: boolean, hasCaps: boolean) => /* glsl */ `
uniform vec3 uHairColor;
uniform vec4 uHairP;
uniform vec4 uHairShift;
uniform vec4 uHairSpec;
uniform vec4 uHairLit;
${strandAttr ? 'varying vec3 vStrandV;' : ''}
${hasCaps ? 'varying float vCapVis;' : ''}
float gShadow = -1.0;
float gHairAO = 1.0;
float gHairLum = 0.5;
vec3 gHairT = vec3(0.0, 1.0, 0.0);
vec3 hairStrandDir(vec3 N) {
  ${
    strandAttr
      ? 'return normalize(vStrandV - N * dot(N, vStrandV));'
      : `
  #ifdef USE_UV
    vec3 q0 = dFdx(-vViewPosition);
    vec3 q1 = dFdy(-vViewPosition);
    vec2 st0 = dFdx(vUv);
    vec2 st1 = dFdy(vUv);
    vec3 q1perp = cross(q1, N);
    vec3 q0perp = cross(N, q0);
    vec3 T = ${alongV ? 'q1perp * st0.y + q0perp * st1.y' : 'q1perp * st0.x + q0perp * st1.x'};
    float l = dot(T, T);
    return l > 0.0 ? T * inversesqrt(l) : normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  #else
    return normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  #endif`
  }
}
float hairLobe(vec3 T, vec3 H, float e) {
  float th = dot(T, H);
  return smoothstep(-1.0, 0.0, th) * pow(sqrt(max(1.0 - th * th, 0.0)), e);
}
void RE_Direct_Hair( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 L = directLight.direction;
  float sh = gShadow < 0.0 ? 1.0 : gShadow;
  gShadow = -1.0;
  vec3 radiance = directLight.color * sh * mix(1.0, gHairAO, uHairLit.z);
  float ndl = dot(geometryNormal, L);
  // Kajiya–Kay: diffuse ∝ sin(T, L), blended with a wrapped N·L so the far side of the head still falls off
  float tl = dot(gHairT, L);
  float kk = sqrt(max(1.0 - tl * tl, 0.0));
  float wrap = saturate((ndl + uHairLit.x) / (1.0 + uHairLit.x));
  reflectedLight.directDiffuse += radiance * (wrap * mix(1.0, kk, 0.6)) * BRDF_Lambert(material.diffuseContribution);
  // Scheuermann: primary (white, shifted to the tip) and secondary (hair-coloured, shifted to the root, sparkling)
  vec3 H = normalize(L + geometryViewDir);
  float sn = (gHairLum - 0.5) * uHairShift.z;
  vec3 T1 = normalize(gHairT + geometryNormal * (uHairShift.x + sn));
  vec3 T2 = normalize(gHairT + geometryNormal * (uHairShift.y + sn));
  float s1 = hairLobe(T1, H, uHairSpec.x) * uHairSpec.z;
  float s2 = hairLobe(T2, H, uHairSpec.y) * uHairSpec.w * (0.4 + 1.2 * gHairLum);
  float lit = smoothstep(-0.1, 0.35, ndl);
  reflectedLight.directSpecular += radiance * lit * (vec3(s1) + s2 * (material.diffuseColor * 2.5 + 0.02));
}
#undef RE_Direct
#define RE_Direct RE_Direct_Hair
`;

export function createHairMaterial(opts: HairMaterialOptions = {}): HairMaterial {
  const msaa = opts.msaa !== false;
  const strandAttr = !!opts.strandAttribute;
  const alongV = (opts.strandAxis ?? 'v') === 'v';
  const capsules = opts.capsules ?? null;
  const uniforms: HairUniforms = {
    uHairColor: u(srgb(opts.color ?? '#2b2119')),
    uHairP: u(new THREE.Vector4(1 / Math.max(opts.texLuminance ?? 0.25, 0.01), 0.75, opts.rootAt === undefined ? 0 : 0.55, 0.3)),
    uHairShift: u(new THREE.Vector4(0.08, -0.12, 0.35, 0.25)),
    uHairSpec: u(new THREE.Vector4(110, 26, 0.16, 0.3)),
    uHairLit: u(new THREE.Vector4(0.45, 0.25, 0.7, 0)),
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: opts.map ?? null,
    roughness: 0.6,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: opts.map ? (opts.alphaTest ?? (msaa ? 0.3 : 0.5)) : 0,
    alphaToCoverage: !!opts.map && msaa,
  });
  mat.defines = { STANDARD: '', USE_UV: '' };
  if (opts.rootAt !== undefined) mat.defines.HAIR_ROOT = opts.rootAt === 0 ? '0' : '1';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    if (capsules) Object.assign(sh.uniforms, capsules.uniforms);
    let vs = sh.vertexShader;
    vs = beforeMain(vs, (strandAttr ? 'attribute vec3 aStrandDir;\nvarying vec3 vStrandV;\n' : '') + (capsules ? 'varying float vCapVis;\n' + GLSL_CAPSULES : ''));
    if (strandAttr) vs = after(vs, 'begin_vertex', 'vStrandV = normalize(normalMatrix * aStrandDir);');
    if (capsules) vs = after(vs, 'project_vertex', 'vCapVis = capsuleVis(mvPosition.xyz, normalize(transformedNormal));');
    sh.vertexShader = vs;

    let fs = sh.fragmentShader;
    fs = after(fs, 'lights_physical_pars_fragment', HAIR_FRAGMENT_PARS(strandAttr, alongV, !!capsules));
    fs = replaceChunk(
      fs,
      'map_fragment',
      /* glsl */ `
      #ifdef USE_MAP
      {
        vec4 hx = texture2D(map, vMapUv);
        gHairLum = dot(hx.rgb, vec3(0.2126, 0.7152, 0.0722));
        // tint: keep only the strand-to-strand luminance variation of the texture
        float rel = mix(1.0, clamp(gHairLum * uHairP.x, 0.0, 2.5), uHairP.y);
        diffuseColor.rgb = uHairColor * rel;
        // minified strands lose coverage → compensate a little per mip level
        vec2 tsz = vec2(textureSize(map, 0));
        vec2 dx = dFdx(vMapUv * tsz);
        vec2 dy = dFdy(vMapUv * tsz);
        float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
        diffuseColor.a *= hx.a * (1.0 + uHairShift.w * lod);
      }
      #else
        diffuseColor.rgb = uHairColor;
      #endif
      #ifdef HAIR_ROOT
      {
        float along = ${alongV ? 'vUv.y' : 'vUv.x'};
        float rootD = HAIR_ROOT == 0 ? along : 1.0 - along;
        diffuseColor.rgb *= mix(1.0 - uHairP.z, 1.0, smoothstep(0.0, uHairP.w, rootD));
      }
      #endif
      `,
    );
    fs = after(
      fs,
      'normal_fragment_maps',
      /* glsl */ `
      gHairT = hairStrandDir(normal);
      ${capsules ? 'gHairAO = vCapVis;' : ''}
      `,
    );
    fs = after(fs, 'lights_physical_fragment', 'material.specularColor *= uHairLit.y;\nmaterial.specularColorBlended = material.specularColor;');
    fs = replaceChunk(fs, 'lights_fragment_begin', lightsBeginWithSeparateShadow());
    fs = after(fs, 'aomap_fragment', 'reflectedLight.indirectDiffuse *= gHairAO;\nreflectedLight.indirectSpecular *= gHairAO;');
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `bt-hair-1|${strandAttr ? 1 : 0}|${alongV ? 1 : 0}|${capsules ? 1 : 0}`;
  if (capsules) mat.onBeforeRender = (_r, _s, camera) => capsules.update(camera);

  const depthMaterial = new THREE.MeshDepthMaterial({ map: opts.map ?? null, alphaTest: opts.map ? 0.4 : 0, side: THREE.DoubleSide });
  return {
    material: mat,
    depthMaterial,
    uniforms,
    setColor(c) {
      uniforms.uHairColor.value.set(c);
    },
    dispose() {
      mat.dispose();
      depthMaterial.dispose();
    },
  };
}

/* ───────────── brows / lashes ───────────── */

export interface BrowLashMaterialOptions {
  kind?: 'brow' | 'lash';
  /** RGBA card texture (sRGB); alpha = coverage. Optional: without it the geometry is drawn solid. */
  map?: THREE.Texture | null;
  color?: THREE.ColorRepresentation;
  msaa?: boolean;
  alphaTest?: number;
}

export interface BrowLashMaterial {
  material: THREE.MeshStandardMaterial;
  uniforms: { uCardColor: Uniform<THREE.Color>; /** x texture contrast, y alpha gain, z specular scale */ uCardP: Uniform<THREE.Vector3> };
  setColor(c: THREE.ColorRepresentation): void;
  dispose(): void;
}

export function createBrowLashMaterial(opts: BrowLashMaterialOptions = {}): BrowLashMaterial {
  const lash = opts.kind === 'lash';
  const msaa = opts.msaa !== false;
  const uniforms = {
    uCardColor: u(srgb(opts.color ?? (lash ? '#0e0a08' : '#2b2119'))),
    uCardP: u(new THREE.Vector3(lash ? 0.2 : 0.6, lash ? 1.25 : 1.1, lash ? 0.1 : 0.35)),
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: opts.map ?? null,
    roughness: lash ? 0.5 : 0.7,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: opts.map ? (opts.alphaTest ?? (msaa ? 0.25 : 0.5)) : 0,
    alphaToCoverage: !!opts.map && msaa,
    // the cards lie on (or a hair's breadth above) the skin
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    let fs = sh.fragmentShader;
    fs = beforeMain(fs, 'uniform vec3 uCardColor;\nuniform vec3 uCardP;');
    fs = replaceChunk(
      fs,
      'map_fragment',
      /* glsl */ `
      #ifdef USE_MAP
      {
        vec4 cx = texture2D(map, vMapUv);
        float lum = dot(cx.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = uCardColor * mix(1.0, clamp(lum * 4.0, 0.3, 2.0), uCardP.x);
        diffuseColor.a *= clamp(cx.a * uCardP.y, 0.0, 1.0);
      }
      #else
        diffuseColor.rgb = uCardColor;
      #endif
      `,
    );
    fs = after(fs, 'lights_physical_fragment', 'material.specularColor *= uCardP.z;\nmaterial.specularColorBlended = material.specularColor;');
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'bt-card-1';
  return {
    material: mat,
    uniforms,
    setColor(c) {
      uniforms.uCardColor.value.set(c);
    },
    dispose() {
      mat.dispose();
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * Studio: environment, lights, floor
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Direction (unit vector) from azimuth (0 = towards the camera at +z, positive = camera right) and elevation, degrees. */
function dirFrom(azDeg: number, elDeg: number, out = new THREE.Vector3()) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

/** The studio layout shared by the environment and the direct lights (degrees, camera-relative). */
export const STUDIO_LAYOUT = {
  key: { az: 38, el: 36 },
  fill: { az: -58, el: 6 },
  rimL: { az: -132, el: 24 },
  rimR: { az: 138, el: 30 },
  top: { az: 180, el: 78 },
} as const;

export interface StudioEnvironment {
  texture: THREE.Texture;
  renderTarget: THREE.WebGLRenderTarget;
  dispose(): void;
}

export interface StudioEnvironmentOptions {
  /** overall radiance multiplier */
  intensity?: number;
  /** PMREM cube size (r187 minimum is 256) */
  size?: number;
}

/**
 * Procedural softbox studio rendered once into a PMREM (6 small draws + the PMREM filter; no files, ~1 MB of GPU memory at 256).
 * Layout matches setupStudioLights so that reflections (eye catch-lights, skin sheen) agree with the direct lights:
 * a large key softbox front-right, a dim cool fill front-left, two tall rim strips behind, a small top light, a warm floor bounce,
 * everything else dark neutral.
 */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer, opts: StudioEnvironmentOptions = {}): StudioEnvironment {
  const k = opts.intensity ?? 1;
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const panel = (az: number, el: number, dist: number, w: number, h: number, color: THREE.ColorRepresentation, intensity: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity * k), side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(g, m);
    dirFrom(az, el, mesh.position).multiplyScalar(dist);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
    disposables.push(g, m);
  };
  // dark neutral shell: slightly lighter walls, darker floor
  const shellG = new THREE.SphereGeometry(20, 24, 12);
  const shellM = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    toneMapped: false,
    uniforms: { uK: { value: k } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform float uK; varying vec3 vD; void main(){ float y = normalize(vD).y; vec3 wall = vec3(0.050, 0.053, 0.060); vec3 floorC = vec3(0.030, 0.027, 0.025); vec3 ceil = vec3(0.070, 0.074, 0.082);' +
      ' vec3 c = mix(floorC, wall, smoothstep(-0.25, 0.05, y)); c = mix(c, ceil, smoothstep(0.3, 0.95, y)); gl_FragColor = vec4(c * uK, 1.0); }',
  });
  scene.add(new THREE.Mesh(shellG, shellM));
  disposables.push(shellG, shellM);

  const L = STUDIO_LAYOUT;
  panel(L.key.az, L.key.el, 6, 5.2, 5.2, '#fff3e6', 7.5); // key softbox (large → soft terminator in reflections)
  panel(L.fill.az, L.fill.el, 6, 5.5, 6.5, '#dfe8ff', 0.85); // fill
  panel(L.rimL.az, L.rimL.el, 6, 1.5, 6.5, '#d6e6ff', 14); // rim strips
  panel(L.rimR.az, L.rimR.el, 6, 1.5, 6.5, '#fff0e0', 11);
  panel(L.top.az, L.top.el, 6, 3.0, 3.0, '#ffffff', 3.2); // hair light
  panel(8, -38, 6, 6.0, 2.6, '#ffe2c8', 0.5); // warm bounce from the floor in front (fills eye sockets, under the chin)

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02, 0.1, 50, { size: opts.size ?? 256 });
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return {
    texture: rt.texture,
    renderTarget: rt,
    dispose() {
      rt.dispose();
    },
  };
}

export interface StudioLightOptions {
  tier?: QualityTier;
  /** subject height in metres (frames the shadow camera) */
  height?: number;
  /** overall multiplier for the direct lights */
  intensity?: number;
  /** 1 = the rig is locked to the camera azimuth (the subject always shows its best side), 0 = fixed in the world */
  follow?: number;
  key?: number;
  fill?: number;
  rim?: number;
}

export interface StudioRig {
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight | null;
  rimL: THREE.DirectionalLight;
  rimR: THREE.DirectionalLight;
  lights: THREE.DirectionalLight[];
  /** how strongly the rig follows the camera azimuth (0..1) */
  follow: number;
  /** current rig azimuth in radians */
  azimuth: number;
  /** re-aim the rig (and scene.environmentRotation) for this camera; call once per frame before rendering */
  update(camera: THREE.Camera): void;
  /** re-frame the shadow camera for a subject of this height (metres), feet at y = 0 */
  setSubject(height: number, center?: THREE.Vector3): void;
  dispose(): void;
}

export function setupStudioLights(scene: THREE.Scene, opts: StudioLightOptions = {}): StudioRig {
  const tier = QUALITY_TIERS[opts.tier ?? 'high'];
  const k = opts.intensity ?? 1;
  const L = STUDIO_LAYOUT;
  const center = new THREE.Vector3(0, (opts.height ?? 1.75) * 0.5, 0);
  let radius = Math.max((opts.height ?? 1.75) * 0.5 + 0.12, 0.9);

  const key = new THREE.DirectionalLight(0xfff1e4, 3.0 * k * (opts.key ?? 1));
  const rimL = new THREE.DirectionalLight(0xd4e4ff, 3.4 * k * (opts.rim ?? 1));
  const rimR = new THREE.DirectionalLight(0xffecd8, 2.6 * k * (opts.rim ?? 1));
  const fill = tier.lights === 4 ? new THREE.DirectionalLight(0xdde6ff, 0.5 * k * (opts.fill ?? 1)) : null;
  const lights = fill ? [key, fill, rimL, rimR] : [key, rimL, rimR];
  for (const l of lights) {
    scene.add(l);
    scene.add(l.target);
  }
  if (tier.shadowMapSize > 0) {
    key.castShadow = true;
    key.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
    key.shadow.radius = tier.shadowRadius;
    // generous normal bias: keeps the wrapped (sub-surface) part of the terminator out of self-shadow
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
  }
  const dir = new THREE.Vector3();
  const place = (l: THREE.DirectionalLight, az: number, el: number, rigAz: number) => {
    dirFrom(az + (rigAz * 180) / Math.PI, el, dir);
    l.position.copy(center).addScaledVector(dir, 4);
    l.target.position.copy(center);
    l.target.updateMatrixWorld();
  };
  const frameShadow = () => {
    const c = key.shadow.camera;
    c.left = -radius;
    c.right = radius;
    c.top = radius;
    c.bottom = -radius;
    c.near = 4 - radius - 0.3;
    c.far = 4 + radius + 0.6;
    c.updateProjectionMatrix();
  };
  frameShadow();

  const rig: StudioRig = {
    key,
    fill,
    rimL,
    rimR,
    lights,
    follow: opts.follow ?? 1,
    azimuth: 0,
    update(camera) {
      const az = Math.atan2(camera.position.x - center.x, camera.position.z - center.z) * rig.follow;
      rig.azimuth = az;
      place(key, L.key.az, L.key.el, az);
      if (fill) place(fill, L.fill.az, L.fill.el, az);
      place(rimL, L.rimL.az, L.rimL.el, az);
      place(rimR, L.rimR.az, L.rimR.el, az);
      scene.environmentRotation.set(0, az, 0);
    },
    setSubject(height, c) {
      if (c) center.copy(c);
      else center.set(0, height * 0.5, 0);
      radius = Math.max(height * 0.5 + 0.12, 0.9);
      frameShadow();
    },
    dispose() {
      for (const l of lights) {
        scene.remove(l);
        scene.remove(l.target);
        l.shadow?.map?.dispose();
        l.dispose();
      }
    },
  };
  place(key, L.key.az, L.key.el, 0);
  if (fill) place(fill, L.fill.az, L.fill.el, 0);
  place(rimL, L.rimL.az, L.rimL.el, 0);
  place(rimR, L.rimR.az, L.rimR.el, 0);
  return rig;
}

/* ───────────── floor: shadow catcher + capsule contact occlusion ───────────── */

export interface StudioFloorOptions {
  capsules?: CapsuleField | null;
  /** disc radius in metres */
  radius?: number;
  /** floor colour (sRGB) – a touch lighter than the backdrop so the pool of light reads as a surface */
  color?: THREE.ColorRepresentation;
  /** 0..1 opacity of the lit floor disc over the backdrop */
  opacity?: number;
  /** darkness of the key-light shadow */
  shadow?: number;
  /** strength of the contact occlusion under the feet */
  contact?: number;
}

export interface StudioFloor {
  mesh: THREE.Mesh;
  material: THREE.ShadowMaterial;
  uniforms: { uFloorColor: Uniform<THREE.Color>; /** x opacity, y shadow darkness, z contact strength, w fade radius */ uFloorP: Uniform<THREE.Vector4> };
  dispose(): void;
}

export function createStudioFloor(opts: StudioFloorOptions = {}): StudioFloor {
  const radius = opts.radius ?? 1.6;
  const capsules = opts.capsules ?? null;
  const uniforms = {
    uFloorColor: u(srgb(opts.color ?? '#3a3f48')),
    uFloorP: u(new THREE.Vector4(opts.opacity ?? 0.55, opts.shadow ?? 0.6, opts.contact ?? 1.0, radius)),
  };
  const mat = new THREE.ShadowMaterial({ transparent: true, depthWrite: false, opacity: 1 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    if (capsules) Object.assign(sh.uniforms, capsules.uniforms);
    let vs = sh.vertexShader;
    vs = beforeMain(vs, 'varying vec3 vFloorV;\nvarying vec3 vFloorN;\nvarying vec2 vFloorXY;');
    vs = after(vs, 'project_vertex', 'vFloorV = mvPosition.xyz;\nvFloorN = normalize(normalMatrix * objectNormal);\nvFloorXY = position.xy;');
    sh.vertexShader = vs;
    let fs = sh.fragmentShader;
    fs = beforeMain(fs, 'uniform vec3 uFloorColor;\nuniform vec4 uFloorP;\nvarying vec3 vFloorV;\nvarying vec3 vFloorN;\nvarying vec2 vFloorXY;\n' + (capsules ? GLSL_GROUND_CAPSULES : ''));
    const line = 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );';
    if (!fs.includes(line)) throw new Error('materials.ts: ShadowMaterial fragment changed (three.js version mismatch?)');
    fs = fs.replace(
      line,
      /* glsl */ `
      float rr = length(vFloorXY) / uFloorP.w;
      float fade = 1.0 - smoothstep(0.35, 1.0, rr);
      float lit = 1.0 - uFloorP.y * (1.0 - getShadowMask());
      ${capsules ? 'lit *= groundCapsuleVis(vFloorV, normalize(vFloorN), uFloorP.z);' : ''}
      // pool of light: brightest under the subject, falling off towards the edge of the disc
      vec3 col = uFloorColor * mix(0.55, 1.0, fade) * lit;
      float a = fade * mix(uFloorP.x, 1.0, 1.0 - lit) * opacity;
      gl_FragColor = vec4( col, a );
      `,
    );
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `bt-floor-1|${capsules ? 1 : 0}`;
  if (capsules) mat.onBeforeRender = (_r, _s, camera) => capsules.update(camera);
  const geo = new THREE.CircleGeometry(radius, 48);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.0005;
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  return {
    mesh,
    material: mat,
    uniforms,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
