import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BodyInfo, BodyInput } from './model';
import type { Girth } from './measure';
import type { WorkerReq, WorkerRes } from './body.worker';
import BodyWorker from './body.worker?worker';

export interface BodyViewerProps {
  input: BodyInput;
  ghost?: BodyInput | null;
  showRings?: boolean;
  view?: { name: 'front' | 'side' | 'back'; nonce: number };
  onMeasured?: (info: BodyInfo, girths: Girth[]) => void;
  className?: string;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function inputKey(i: BodyInput | null | undefined) {
  if (!i) return '';
  return [i.sex, i.heightCm.toFixed(1), i.weight.toFixed(2), i.fatKg.toFixed(3), i.ffm.toFixed(2), (i.smm ?? 0).toFixed(2)].join('|');
}

const SKIN_VERT_DECL = /* glsl */ `
varying vec3 vBodyPos;
`;
const SKIN_FRAG_DECL = /* glsl */ `
varying vec3 vBodyPos;
uniform float uH;
uniform float uAbs;
uniform float uDef;
uniform float uMale;
uniform vec3 uRimColor;
uniform float uRim;
float gline(float d, float w) { return exp(-(d * d) / (w * w)); }
// height field (meters) of abdominal muscle relief
float absField(vec3 p) {
  float H = uH;
  float y = p.y / H;
  float x = p.x;
  float ax = abs(x);
  if (p.z < 0.0) return 0.0;
  float top = uMale > 0.5 ? 0.705 : 0.69;
  float bot = uMale > 0.5 ? 0.575 : 0.565;
  float halfW = 0.046 * H * (uMale > 0.5 ? 1.0 : 0.9);
  float inY = smoothstep(bot, bot + 0.02, y) * (1.0 - smoothstep(top - 0.015, top, y));
  float inX = 1.0 - smoothstep(halfW * 0.85, halfW * 1.15, ax);
  float region = inY * inX;
  float h = 0.0;
  // linea alba
  h -= gline(x, 0.008) * region;
  // tendinous intersections (slightly curved)
  float cy = y * H - 0.035 * ax * ax / (halfW * halfW) * 0.4;
  float g = 0.0;
  g += gline(cy - 0.606 * H, 0.0085);
  g += gline(cy - 0.643 * H, 0.0085);
  g += gline(cy - 0.676 * H, 0.008);
  h -= g * region * 0.85;
  // linea semilunaris (lateral border)
  h -= gline(ax - halfW, 0.011) * inY * 0.8;
  // block convexity
  h += region * 0.35;
  // adonis / V lines from iliac crest towards pubis
  float vy = y * H;
  float vlx = mix(halfW * 1.25, halfW * 0.3, clamp((0.585 * H - vy) / (0.06 * H), 0.0, 1.0));
  float vReg = smoothstep(0.515, 0.535, y) * (1.0 - smoothstep(0.585, 0.6, y));
  h -= gline(ax - vlx, 0.01) * vReg * 0.8;
  return h * 0.0045 * uAbs;
}
`;

function makeSkinMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#6f7889'),
    roughness: 0.46,
    metalness: 0.04,
    clearcoat: 0.15,
    clearcoatRoughness: 0.42,
    sheen: 0.2,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color('#8fb6ff'),
    envMapIntensity: 0.35,
  });
  const uniforms = {
    uH: { value: 1.78 },
    uAbs: { value: 0 },
    uDef: { value: 0 },
    uMale: { value: 1 },
    uRimColor: { value: new THREE.Color('#5fd8ff') },
    uRim: { value: 0.32 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = SKIN_VERT_DECL + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vBodyPos = position;');
    shader.fragmentShader =
      SKIN_FRAG_DECL +
      shader.fragmentShader
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float hb = absField(vBodyPos);
            vec3 surf = -vViewPosition;
            vec3 sX = dFdx(surf);
            vec3 sY = dFdy(surf);
            vec3 R1 = cross(sY, normal);
            vec3 R2 = cross(normal, sX);
            float det = dot(sX, R1) * faceDirection;
            float dHx = dFdx(hb);
            float dHy = dFdy(hb);
            vec3 grad = sign(det) * (dHx * R1 + dHy * R2);
            normal = normalize(abs(det) * normal - grad);
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            float fr = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
            totalEmissiveRadiance += uRimColor * pow(fr, 3.2) * uRim;
          }`,
        );
  };
  return { mat, uniforms };
}

function makeGhostMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color('#ffb547') }, uAlpha: { value: 0.9 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha;
      varying vec3 vN; varying vec3 vV;
      void main(){
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float a = pow(f, 2.4) * uAlpha;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
}

function makeFloor() {
  const g = new THREE.Group();
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(120,200,255,0.20)');
  grd.addColorStop(0.45, 'rgba(90,140,255,0.08)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(140,220,255,0.35)';
  for (let r = 0; r < 5; r++) {
    ctx.lineWidth = r === 2 ? 2 : 1;
    ctx.globalAlpha = r === 2 ? 0.9 : 0.35;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * (0.16 + r * 0.075), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const disk = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 2.2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  disk.rotation.x = -Math.PI / 2;
  disk.position.y = 0.001;
  g.add(disk);
  // soft contact shadow
  const cv2 = document.createElement('canvas');
  cv2.width = cv2.height = 256;
  const c2 = cv2.getContext('2d')!;
  const g2 = c2.createRadialGradient(128, 128, 0, 128, 128, 128);
  g2.addColorStop(0, 'rgba(0,0,0,0.75)');
  g2.addColorStop(0.5, 'rgba(0,0,0,0.35)');
  g2.addColorStop(1, 'rgba(0,0,0,0)');
  c2.fillStyle = g2;
  c2.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.45),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv2), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  g.add(shadow);
  return g;
}

export default function BodyViewer({ input, ghost, showRings, view, onMeasured, className }: BodyViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadMsg, setLoadMsg] = useState('Сканирую тело…');
  const api = useRef<{
    request: (ch: 'main' | 'ghost', i: BodyInput, measure: boolean) => void;
    setRings: (on: boolean) => void;
    setGhostVisible: (on: boolean) => void;
    setView: (v: 'front' | 'side' | 'back') => void;
    ready: boolean;
  } | null>(null);
  const onMeasuredRef = useRef(onMeasured);
  onMeasuredRef.current = onMeasured;
  const latest = useRef({ input, ghost, showRings });
  latest.current = { input, ghost, showRings };

  // ── one-time scene setup ──
  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
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
    controls.minDistance = 1.4;
    controls.maxDistance = 7;
    controls.minPolarAngle = Math.PI * 0.2;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.7;
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

    // lights
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x101218, 0.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1.6, 3.2, 2.6);
    scene.add(key);
    const rimA = new THREE.DirectionalLight(0x52c8ff, 2.2);
    rimA.position.set(-2.5, 1.8, -2.4);
    scene.add(rimA);
    const rimB = new THREE.DirectionalLight(0x9a7bff, 1.5);
    rimB.position.set(2.6, 1.2, -2.2);
    scene.add(rimB);
    const fill = new THREE.DirectionalLight(0xffe9d6, 0.35);
    fill.position.set(-2, 0.6, 2.2);
    scene.add(fill);

    scene.add(makeFloor());

    const { mat, uniforms } = makeSkinMaterial();
    const ghostMat = makeGhostMaterial();
    const geom = new THREE.BufferGeometry();
    const ghostGeom = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geom, mat);
    const ghostMesh = new THREE.Mesh(ghostGeom, ghostMat);
    ghostMesh.renderOrder = 2;
    mesh.visible = false;
    ghostMesh.visible = false;
    scene.add(mesh, ghostMesh);

    const rings = new THREE.Group();
    scene.add(rings);
    let ringsOn = !!latest.current.showRings;
    let ghostOn = false;
    let lastGirths: Girth[] = [];

    // morph animation state
    let cur: { p: Float32Array; n: Float32Array } | null = null;
    let anim: { from: { p: Float32Array; n: Float32Array }; to: { p: Float32Array; n: Float32Array }; t0: number; dur: number } | null = null;
    let ghostCur: { p: Float32Array; n: Float32Array } | null = null;

    const worker: Worker = new BodyWorker();
    let reqId = 0;
    let disposed = false;

    const buildRings = (girths: Girth[]) => {
      lastGirths = girths;
      rings.clear();
      for (const g of girths) {
        if (!g.ring.length) continue;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < g.ring.length; i += 3) pts.push(new THREE.Vector3(g.ring[i], g.ring[i + 1], g.ring[i + 2]));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        // slightly inflate so the line sits on the skin
        const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x7cf7c8, transparent: true, opacity: 0.95, depthTest: true }));
        line.scale.setScalar(1.0);
        rings.add(line);
      }
      rings.visible = ringsOn;
      renderLabels();
    };

    const labelEls = new Map<string, HTMLDivElement>();
    const renderLabels = () => {
      const box = labelsRef.current;
      if (!box) return;
      const show = ringsOn && mesh.visible;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const seen = new Set<string>();
      if (show) {
        const anchors: { g: Girth; x: number; y: number }[] = [];
        const v = new THREE.Vector3();
        for (const g of lastGirths) {
          if (!g.ring.length || g.key === 'forearm') continue;
          // anchor: ring point with max screen-x
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
        // resolve vertical collisions
        anchors.sort((a, b) => a.y - b.y);
        for (let i = 1; i < anchors.length; i++) if (anchors[i].y < anchors[i - 1].y + 21) anchors[i].y = anchors[i - 1].y + 21;
        const maxX = Math.max(...anchors.map((a) => a.x));
        for (const a of anchors) {
          let el = labelEls.get(a.g.key);
          if (!el) {
            el = document.createElement('div');
            el.className = 'ring-label';
            box.appendChild(el);
            labelEls.set(a.g.key, el);
          }
          el.textContent = `${a.g.label} ${a.g.cm.toFixed(1)}`;
          const x = Math.min(a.x, w - 130, maxX);
          el.style.transform = `translate(${Math.max(0, x)}px, ${a.y}px)`;
          el.style.display = '';
          seen.add(a.g.key);
        }
      }
      for (const [k, el] of labelEls) if (!seen.has(k)) el.style.display = 'none';
    };

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

    const applyInfo = (info: BodyInfo) => {
      uniforms.uH.value = info.heightM;
      uniforms.uAbs.value = info.absVis;
      uniforms.uDef.value = info.definition;
    };

    worker.onmessage = (e: MessageEvent<WorkerRes>) => {
      if (disposed) return;
      const m = e.data;
      if (m.type === 'error') {
        console.error('body worker', m.message);
        setStatus('error');
        return;
      }
      if (m.type === 'mesh') {
        geom.setIndex(new THREE.BufferAttribute(m.indices, 1));
        ghostGeom.setIndex(new THREE.BufferAttribute(m.indices, 1));
        cur = { p: m.positions, n: m.normals };
        setAttr(geom, m.positions, m.normals);
        uniforms.uMale.value = latest.current.input.sex === 'male' ? 1 : 0;
        applyInfo(m.info);
        mesh.visible = true;
        buildRings(m.girths);
        onMeasuredRef.current?.(m.info, m.girths);
        setStatus('ready');
        if (api.current) api.current.ready = true;
        // catch up with props that may have changed meanwhile
        const L = latest.current;
        if (inputKey(L.input) !== sentKey.main) request('main', L.input, true);
        if (L.ghost) request('ghost', L.ghost, false);
        return;
      }
      if (m.type === 'morph') {
        if (m.channel === 'main') {
          const from = cur ? { p: new Float32Array((geom.getAttribute('position') as THREE.BufferAttribute).array as Float32Array), n: new Float32Array((geom.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array) } : null;
          const to = { p: m.positions, n: m.normals };
          if (from) anim = { from, to, t0: performance.now(), dur: 900 };
          else setAttr(geom, to.p, to.n);
          cur = to;
          applyInfo(m.info);
          if (m.girths) {
            buildRings(m.girths);
            onMeasuredRef.current?.(m.info, m.girths);
          }
        } else {
          ghostCur = { p: m.positions, n: m.normals };
          setAttr(ghostGeom, m.positions, m.normals);
          ghostMesh.visible = ghostOn;
        }
      }
    };

    const sentKey: Record<string, string> = { main: '', ghost: '' };
    const request = (ch: 'main' | 'ghost', i: BodyInput, measure: boolean) => {
      const k = inputKey(i);
      if (sentKey[ch] === k) return;
      sentKey[ch] = k;
      const msg: WorkerReq = { type: 'morph', id: ++reqId, channel: ch, input: i, measure };
      worker.postMessage(msg);
    };

    sentKey.main = inputKey(input);
    worker.postMessage({ type: 'init', id: ++reqId, input } satisfies WorkerReq);
    const slowTimer = window.setTimeout(() => setLoadMsg('Строю 3D-модель… (только при первом запуске)'), 1800);

    let viewAnim: { from: number; to: number; t0: number } | null = null;
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
        ghostMesh.visible = on && !!ghostCur;
      },
      setView: (v) => {
        const target = v === 'front' ? 0 : v === 'side' ? Math.PI / 2 : Math.PI;
        const cur = controls.getAzimuthalAngle();
        let to = target;
        while (to - cur > Math.PI) to -= Math.PI * 2;
        while (to - cur < -Math.PI) to += Math.PI * 2;
        controls.autoRotate = false;
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => (controls.autoRotate = true), 8000);
        viewAnim = { from: cur, to, t0: performance.now() };
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
      // fit the whole body vertically
      const Hm = latest.current.input.heightCm / 100;
      const fitH = Hm * 1.18;
      const dist = fitH / 2 / Math.tan((camera.fov * Math.PI) / 360);
      const fitW = 1.25;
      const distW = fitW / 2 / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect;
      const d = Math.max(dist, distW);
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
        const pa = geom.getAttribute('position') as THREE.BufferAttribute;
        const na = geom.getAttribute('normal') as THREE.BufferAttribute;
        const P = pa.array as Float32Array;
        const N = na.array as Float32Array;
        const fp = anim.from.p,
          tp = anim.to.p,
          fn = anim.from.n,
          tn = anim.to.n;
        for (let i = 0; i < P.length; i++) {
          P[i] = fp[i] + (tp[i] - fp[i]) * e;
          N[i] = fn[i] + (tn[i] - fn[i]) * e;
        }
        pa.needsUpdate = true;
        na.needsUpdate = true;
        if (t >= 1) {
          anim = null;
          geom.computeBoundingSphere();
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
      controls.update();
      renderer.render(scene, camera);
      if (ringsOn) renderLabels();
    };
    tick();

    return () => {
      disposed = true;
      window.clearTimeout(slowTimer);
      window.clearTimeout(idleTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      worker.terminate();
      controls.dispose();
      geom.dispose();
      ghostGeom.dispose();
      mat.dispose();
      ghostMat.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelEls.forEach((el) => el.remove());
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.sex, Math.round(input.heightCm)]);

  // ── react to prop changes ──
  useEffect(() => {
    if (api.current?.ready) api.current.request('main', input, true);
  }, [inputKey(input)]);

  useEffect(() => {
    if (!api.current) return;
    if (ghost) {
      if (api.current.ready) api.current.request('ghost', ghost, false);
      api.current.setGhostVisible(true);
    } else api.current.setGhostVisible(false);
  }, [inputKey(ghost), status]);

  useEffect(() => {
    api.current?.setRings(!!showRings);
  }, [showRings, status]);

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
          <span>{status === 'error' ? 'Не удалось построить модель' : loadMsg}</span>
        </div>
      )}
    </div>
  );
}
