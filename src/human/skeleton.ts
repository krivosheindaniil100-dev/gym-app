/**
 * Skeletal skinning of the MakeHuman base mesh + the baked relaxed standing pose.
 *
 * Asset: public/human/skeleton.json + skeleton.bin (tools/mh/build_skeleton.py, which also contains the numpy
 * reference implementation this file is tested against).
 *
 * Conventions
 * - Units: DECIMETRES (same as fit.ts `pos`), y up, +z = front, +x = the model's LEFT side.
 * - Positions: Float32Array of ALL base vertices (19158 × xyz), REST pose = MakeHuman A-pose.
 * - A joint is the mean of a few helper vertices, so `computeJoints` must run on every new morphed mesh.
 * - A pose is one rotation per bone in GLOBAL axes about the bone head, composed parent-first
 *   (M_bone = M_parent · T(head) · R · T(-head)); skinning is linear blend with ≤ 4 uint8 weights.
 * - Bones: 47 = root + every bone the relaxed pose rotates (clavicle, shoulder01, upperarm01, lowerarm01/02,
 *   wrist, 15 finger bones, upperleg01, foot per side). All other MakeHuman bones are merged into their nearest
 *   kept ancestor, so spine / neck / head / face are rigid with the root and stay exactly as in the rest mesh.
 * - `t` blends rest (0) → relaxed pose (1) by per-bone slerp. Extra abduction angles and the baked
 *   delta-mush corrective are scaled by `t` as well, so t = 0 returns the input mesh unchanged.
 *
 * No DOM / WebGL: safe inside a Web Worker. All functions accept optional output buffers (allocation-free).
 */

export interface SkeletonJson {
  unit: string;
  nVerts: number;
  /** decimetres per int8 step of the pose corrective */
  corrScale: number;
  /** section name → [byte offset, element count] inside skeleton.bin */
  layout: Record<string, [number, number]>;
  bones: { name: string; parent: number; head: number; q: number[]; arm?: number; leg?: number }[];
  joints: { name: string; bone: number }[];
  capsules: { name: string; type: string; a?: number; b?: number; axis?: string; bone?: number; k: number }[];
}

export interface Skeleton {
  nVerts: number;
  nBones: number;
  nJoints: number;
  nCapsules: number;
  boneNames: string[];
  /**
   * Joint names. A joint named like a MakeHuman bone is that bone's HEAD: 'upperarm01.L' = left shoulder,
   * 'lowerarm01.L' = elbow, 'wrist.L', 'upperleg01.L' = hip, 'lowerleg01.L' = knee, 'foot.L' = ankle,
   * 'toe3-1.L' = ball of the foot, 'root' / 'spine05' (pelvis), 'spine03' (navel), 'spine01' (chest),
   * 'neck01' (neck base), 'head' (skull base), 'head_top', 'fingerN-M.L' (finger joints), 'fingertipN.L'.
   */
  jointNames: string[];
  /** head, neck, chest, abdomen, pelvis, then upperarm/forearm/hand/thigh/shank/foot .L and .R */
  capsuleNames: string[];
  boneParent: Int16Array;
  /** joint index of every bone's head (rotation pivot) */
  boneHead: Uint16Array;
  /** per bone: unit axis xyz + HALF angle (rad) of the baked pose rotation */
  boneAxisHalf: Float32Array;
  /** per bone: sign of armAbductionDeg / legAbductionDeg applied about world z at the posed bone head */
  boneArm: Int8Array;
  boneLeg: Int8Array;
  /** bone whose matrix moves each joint */
  jointBone: Uint16Array;
  jointOffset: Uint16Array;
  jointVerts: Uint16Array;
  /** per vertex 4 × (bone index × 12), dominant influence first */
  skinOffset: Uint16Array;
  /** per vertex 4 normalised weights (uint8 / 255), descending */
  skinWeight: Float32Array;
  corrIndex: Uint16Array;
  /** rest-space pose corrective, decimetres */
  corrVec: Float32Array;
  /** 0 = limb (between joints capA → capB), 1 = horizontal slab along x, 2 = vertical (head) */
  capType: Uint8Array;
  capA: Uint16Array;
  capB: Uint16Array;
  capK: Float32Array;
  capOffset: Uint16Array;
  capVerts: Uint16Array;
  probes: Record<string, Uint16Array>;
  /** internal scratch buffers */
  scratch: { pts: Float32Array; grid: Float32Array; joints: Float32Array; pose: Pose };
}

export interface Pose {
  /** nBones × 12: row-major 3×4 matrices (r00 r01 r02 tx | r10 … ) taking REST decimetres to POSED decimetres */
  matrices: Float32Array;
  t: number;
  armAbductionDeg: number;
  legAbductionDeg: number;
}

export interface PoseOptions {
  /** 0 = rest A-pose, 1 = relaxed standing pose (default 1) */
  t?: number;
  /** extra outward rotation of both upper arms about the front-back axis through the shoulder joint, degrees */
  armAbductionDeg?: number;
  /** extra outward rotation of both legs about the front-back axis through the hip joint (feet stay flat), degrees */
  legAbductionDeg?: number;
}

export interface AbductionOptions {
  /** clearance kept between forearm / hand and the torso + thigh surface, dm (default 0.1 = 1 cm) */
  armGapDm?: number;
  /** total soft-tissue overlap tolerated where the upper arm rests on the chest and where the thighs meet, dm (default 0.2) */
  softDm?: number;
  maxArmDeg?: number;
  maxLegDeg?: number;
}

const DEG = Math.PI / 180;
const GRID = 40;

export function loadSkeleton(json: SkeletonJson, bin: ArrayBuffer): Skeleton {
  const L = json.layout;
  const u8 = (k: string) => new Uint8Array(bin, L[k][0], L[k][1]);
  const u16 = (k: string) => new Uint16Array(bin, L[k][0], L[k][1]);
  const nVerts = json.nVerts;
  const nBones = json.bones.length;
  const nJoints = json.joints.length;
  const nCapsules = json.capsules.length;

  const boneParent = new Int16Array(nBones);
  const boneHead = new Uint16Array(nBones);
  const boneAxisHalf = new Float32Array(nBones * 4);
  const boneArm = new Int8Array(nBones);
  const boneLeg = new Int8Array(nBones);
  json.bones.forEach((b, i) => {
    boneParent[i] = b.parent;
    boneHead[i] = b.head;
    boneArm[i] = b.arm ?? 0;
    boneLeg[i] = b.leg ?? 0;
    const half = Math.acos(Math.min(1, b.q[3]));
    const s = Math.sin(half);
    if (s > 1e-9) boneAxisHalf.set([b.q[0] / s, b.q[1] / s, b.q[2] / s, half], i * 4);
  });

  const si = u8('skinIndex');
  const sw = u8('skinWeight');
  const skinOffset = new Uint16Array(nVerts * 4);
  const skinWeight = new Float32Array(nVerts * 4);
  for (let i = 0; i < nVerts * 4; i++) {
    skinOffset[i] = si[i] * 12;
    skinWeight[i] = sw[i] / 255;
  }
  const cv = new Int8Array(bin, L.corrVec[0], L.corrVec[1]);
  const corrVec = new Float32Array(cv.length);
  for (let i = 0; i < cv.length; i++) corrVec[i] = cv[i] * json.corrScale;

  const capType = new Uint8Array(nCapsules);
  const capA = new Uint16Array(nCapsules);
  const capB = new Uint16Array(nCapsules);
  const capK = new Float32Array(nCapsules);
  json.capsules.forEach((c, i) => {
    capType[i] = c.type === 'limb' ? 0 : c.axis === 'x' ? 1 : 2;
    capA[i] = c.type === 'limb' ? (c.a ?? 0) : (c.bone ?? 0);
    capB[i] = c.b ?? 0;
    capK[i] = c.k;
  });

  const probes: Record<string, Uint16Array> = {};
  let maxProbe = 0;
  for (const k of Object.keys(L))
    if (k.startsWith('probe_')) {
      probes[k.slice(6)] = u16(k);
      maxProbe = Math.max(maxProbe, L[k][1]);
    }

  return {
    nVerts,
    nBones,
    nJoints,
    nCapsules,
    boneNames: json.bones.map((b) => b.name),
    jointNames: json.joints.map((j) => j.name),
    capsuleNames: json.capsules.map((c) => c.name),
    boneParent,
    boneHead,
    boneAxisHalf,
    boneArm,
    boneLeg,
    jointBone: Uint16Array.from(json.joints, (j) => j.bone),
    jointOffset: u16('jointOffset'),
    jointVerts: u16('jointVerts'),
    skinOffset,
    skinWeight,
    corrIndex: u16('corrIndex'),
    corrVec,
    capType,
    capA,
    capB,
    capK,
    capOffset: u16('capOffset'),
    capVerts: u16('capVerts'),
    probes,
    scratch: {
      pts: new Float32Array(maxProbe * 3),
      grid: new Float32Array(GRID * GRID),
      joints: new Float32Array(nJoints * 3),
      pose: { matrices: new Float32Array(nBones * 12), t: 1, armAbductionDeg: 0, legAbductionDeg: 0 },
    },
  };
}

/** Index of a named joint (see Skeleton.jointNames); throws on unknown names. */
export function jointIndex(skel: Skeleton, name: string): number {
  const i = skel.jointNames.indexOf(name);
  if (i < 0) throw new Error(`skeleton: unknown joint ${name}`);
  return i;
}

/** REST joint positions (nJoints × xyz, dm) of a morphed rest mesh: mean of each joint's helper vertices. */
export function computeJoints(skel: Skeleton, posDm: Float32Array, out: Float32Array = new Float32Array(skel.nJoints * 3)): Float32Array {
  const off = skel.jointOffset;
  const jv = skel.jointVerts;
  for (let j = 0; j < skel.nJoints; j++) {
    let x = 0;
    let y = 0;
    let z = 0;
    const a = off[j];
    const b = off[j + 1];
    for (let k = a; k < b; k++) {
      const v = jv[k] * 3;
      x += posDm[v];
      y += posDm[v + 1];
      z += posDm[v + 2];
    }
    const inv = 1 / (b - a);
    out[j * 3] = x * inv;
    out[j * 3 + 1] = y * inv;
    out[j * 3 + 2] = z * inv;
  }
  return out;
}

/** Skin matrices for the relaxed pose blended by `t`, plus optional extra arm / leg abduction. */
export function poseBones(skel: Skeleton, joints: Float32Array, opts: PoseOptions = {}, out?: Pose): Pose {
  const t = opts.t ?? 1;
  const pose = out ?? { matrices: new Float32Array(skel.nBones * 12), t, armAbductionDeg: 0, legAbductionDeg: 0 };
  pose.t = t;
  pose.armAbductionDeg = opts.armAbductionDeg ?? 0;
  pose.legAbductionDeg = opts.legAbductionDeg ?? 0;
  const arm = pose.armAbductionDeg * t * DEG;
  const leg = pose.legAbductionDeg * t * DEG;
  const M = pose.matrices;
  const ax = skel.boneAxisHalf;
  for (let i = 0, m = 0; i < skel.nBones; i++, m += 12) {
    // local rotation = slerp(identity, baked quaternion, t)
    const half = ax[i * 4 + 3] * t;
    const s = Math.sin(half);
    const w = Math.cos(half);
    const x = ax[i * 4] * s;
    const y = ax[i * 4 + 1] * s;
    const z = ax[i * 4 + 2] * s;
    let r00 = 1 - 2 * (y * y + z * z);
    let r01 = 2 * (x * y - z * w);
    let r02 = 2 * (x * z + y * w);
    let r10 = 2 * (x * y + z * w);
    let r11 = 1 - 2 * (x * x + z * z);
    let r12 = 2 * (y * z - x * w);
    let r20 = 2 * (x * z - y * w);
    let r21 = 2 * (y * z + x * w);
    let r22 = 1 - 2 * (x * x + y * y);
    const h = skel.boneHead[i] * 3;
    const hx = joints[h];
    const hy = joints[h + 1];
    const hz = joints[h + 2];
    let px = hx; // posed position of the bone head
    let py = hy;
    let pz = hz;
    const p = skel.boneParent[i];
    if (p >= 0) {
      const q = p * 12;
      const a00 = M[q], a01 = M[q + 1], a02 = M[q + 2];
      const a10 = M[q + 4], a11 = M[q + 5], a12 = M[q + 6];
      const a20 = M[q + 8], a21 = M[q + 9], a22 = M[q + 10];
      px = a00 * hx + a01 * hy + a02 * hz + M[q + 3];
      py = a10 * hx + a11 * hy + a12 * hz + M[q + 7];
      pz = a20 * hx + a21 * hy + a22 * hz + M[q + 11];
      const l00 = a00 * r00 + a01 * r10 + a02 * r20, l01 = a00 * r01 + a01 * r11 + a02 * r21, l02 = a00 * r02 + a01 * r12 + a02 * r22;
      const l10 = a10 * r00 + a11 * r10 + a12 * r20, l11 = a10 * r01 + a11 * r11 + a12 * r21, l12 = a10 * r02 + a11 * r12 + a12 * r22;
      const l20 = a20 * r00 + a21 * r10 + a22 * r20, l21 = a20 * r01 + a21 * r11 + a22 * r21, l22 = a20 * r02 + a21 * r12 + a22 * r22;
      r00 = l00; r01 = l01; r02 = l02;
      r10 = l10; r11 = l11; r12 = l12;
      r20 = l20; r21 = l21; r22 = l22;
    }
    const ang = skel.boneArm[i] * arm + skel.boneLeg[i] * leg;
    if (ang !== 0) {
      // abduction: rotate about the WORLD z axis through the posed head
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const b00 = c * r00 - sn * r10, b01 = c * r01 - sn * r11, b02 = c * r02 - sn * r12;
      r10 = sn * r00 + c * r10; r11 = sn * r01 + c * r11; r12 = sn * r02 + c * r12;
      r00 = b00; r01 = b01; r02 = b02;
    }
    M[m] = r00; M[m + 1] = r01; M[m + 2] = r02; M[m + 3] = px - (r00 * hx + r01 * hy + r02 * hz);
    M[m + 4] = r10; M[m + 5] = r11; M[m + 6] = r12; M[m + 7] = py - (r10 * hx + r11 * hy + r12 * hz);
    M[m + 8] = r20; M[m + 9] = r21; M[m + 10] = r22; M[m + 11] = pz - (r20 * hx + r21 * hy + r22 * hz);
  }
  return pose;
}

/**
 * Linear blend skinning of all base vertices (helpers included) + the baked pose corrective.
 * `posIn` / result: same layout, decimetres. `out` may be `posIn` (in place).
 */
export function skin(skel: Skeleton, pose: Pose, posIn: Float32Array, out: Float32Array = new Float32Array(posIn.length)): Float32Array {
  const M = pose.matrices;
  const so = skel.skinOffset;
  const sw = skel.skinWeight;
  const n = Math.min(skel.nVerts, Math.floor(posIn.length / 3));
  for (let v = 0, k = 0, o = 0; v < n; v++, k += 4, o += 3) {
    const x = posIn[o];
    const y = posIn[o + 1];
    const z = posIn[o + 2];
    let m = so[k];
    const w0 = sw[k];
    if (w0 === 1) {
      out[o] = M[m] * x + M[m + 1] * y + M[m + 2] * z + M[m + 3];
      out[o + 1] = M[m + 4] * x + M[m + 5] * y + M[m + 6] * z + M[m + 7];
      out[o + 2] = M[m + 8] * x + M[m + 9] * y + M[m + 10] * z + M[m + 11];
      continue;
    }
    let a0 = w0 * M[m], a1 = w0 * M[m + 1], a2 = w0 * M[m + 2], a3 = w0 * M[m + 3];
    let a4 = w0 * M[m + 4], a5 = w0 * M[m + 5], a6 = w0 * M[m + 6], a7 = w0 * M[m + 7];
    let a8 = w0 * M[m + 8], a9 = w0 * M[m + 9], a10 = w0 * M[m + 10], a11 = w0 * M[m + 11];
    for (let j = 1; j < 4; j++) {
      const w = sw[k + j];
      if (w === 0) break;
      m = so[k + j];
      a0 += w * M[m]; a1 += w * M[m + 1]; a2 += w * M[m + 2]; a3 += w * M[m + 3];
      a4 += w * M[m + 4]; a5 += w * M[m + 5]; a6 += w * M[m + 6]; a7 += w * M[m + 7];
      a8 += w * M[m + 8]; a9 += w * M[m + 9]; a10 += w * M[m + 10]; a11 += w * M[m + 11];
    }
    out[o] = a0 * x + a1 * y + a2 * z + a3;
    out[o + 1] = a4 * x + a5 * y + a6 * z + a7;
    out[o + 2] = a8 * x + a9 * y + a10 * z + a11;
  }
  // pose corrective (baked delta mush): rest-space offset rotated by the blended matrix, scaled by t
  const tc = pose.t;
  if (tc !== 0) {
    const ci = skel.corrIndex;
    const cv = skel.corrVec;
    for (let c = 0; c < ci.length; c++) {
      const v = ci[c];
      if (v >= n) continue;
      const k = v * 4;
      let a0 = 0, a1 = 0, a2 = 0, a4 = 0, a5 = 0, a6 = 0, a8 = 0, a9 = 0, a10 = 0;
      for (let j = 0; j < 4; j++) {
        const w = sw[k + j];
        if (w === 0) break;
        const m = so[k + j];
        a0 += w * M[m]; a1 += w * M[m + 1]; a2 += w * M[m + 2];
        a4 += w * M[m + 4]; a5 += w * M[m + 5]; a6 += w * M[m + 6];
        a8 += w * M[m + 8]; a9 += w * M[m + 9]; a10 += w * M[m + 10];
      }
      const cx = cv[c * 3] * tc;
      const cy = cv[c * 3 + 1] * tc;
      const cz = cv[c * 3 + 2] * tc;
      out[v * 3] += a0 * cx + a1 * cy + a2 * cz;
      out[v * 3 + 1] += a4 * cx + a5 * cy + a6 * cz;
      out[v * 3 + 2] += a8 * cx + a9 * cy + a10 * cz;
    }
  }
  return out;
}

/** Posed joint positions (nJoints × xyz, dm) from the rest joints. */
export function poseJoints(skel: Skeleton, pose: Pose, joints: Float32Array, out: Float32Array = new Float32Array(skel.nJoints * 3)): Float32Array {
  const M = pose.matrices;
  for (let j = 0, o = 0; j < skel.nJoints; j++, o += 3) {
    const m = skel.jointBone[j] * 12;
    const x = joints[o];
    const y = joints[o + 1];
    const z = joints[o + 2];
    out[o] = M[m] * x + M[m + 1] * y + M[m + 2] * z + M[m + 3];
    out[o + 1] = M[m + 4] * x + M[m + 5] * y + M[m + 6] * z + M[m + 7];
    out[o + 2] = M[m + 8] * x + M[m + 9] * y + M[m + 10] * z + M[m + 11];
  }
  return out;
}

/**
 * Body capsules for analytic ambient occlusion: nCapsules × 7 = (ax, ay, az, bx, by, bz, radius) in POSED
 * decimetres, order = Skeleton.capsuleNames. Radii / torso slabs are measured on the REST mesh `posDm`
 * (the mesh the joints were computed from), end points are moved by the pose.
 */
export function computeCapsules(
  skel: Skeleton,
  pose: Pose,
  joints: Float32Array,
  posDm: Float32Array,
  out: Float32Array = new Float32Array(skel.nCapsules * 7),
): Float32Array {
  const M = pose.matrices;
  const cv = skel.capVerts;
  for (let c = 0, o = 0; c < skel.nCapsules; c++, o += 7) {
    const v0 = skel.capOffset[c];
    const v1 = skel.capOffset[c + 1];
    let ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number;
    let ma: number, mb: number;
    if (skel.capType[c] === 0) {
      const ja = skel.capA[c] * 3;
      const jb = skel.capB[c] * 3;
      ax = joints[ja]; ay = joints[ja + 1]; az = joints[ja + 2];
      bx = joints[jb]; by = joints[jb + 1]; bz = joints[jb + 2];
      let dx = bx - ax, dy = by - ay, dz = bz - az;
      const inv = 1 / Math.hypot(dx, dy, dz);
      dx *= inv; dy *= inv; dz *= inv;
      let sum = 0;
      for (let k = v0; k < v1; k++) {
        const v = cv[k] * 3;
        const rx = posDm[v] - ax, ry = posDm[v + 1] - ay, rz = posDm[v + 2] - az;
        const d = rx * dx + ry * dy + rz * dz;
        sum += Math.hypot(rx - d * dx, ry - d * dy, rz - d * dz);
      }
      r = (sum / (v1 - v0)) * skel.capK[c];
      ma = skel.jointBone[skel.capA[c]] * 12;
      mb = skel.jointBone[skel.capB[c]] * 12;
    } else {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, ys = 0;
      for (let k = v0; k < v1; k++) {
        const v = cv[k] * 3;
        const x = posDm[v], y = posDm[v + 1], z = posDm[v + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
        ys += y;
      }
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const ex = (x1 - x0) / 2, ey = (y1 - y0) / 2, ez = (z1 - z0) / 2;
      if (skel.capType[c] === 1) {
        // torso slab: horizontal capsule, radius = half depth
        r = ez * skel.capK[c];
        const hl = Math.max(ex - r, 0);
        const cy = ys / (v1 - v0);
        ax = cx - hl; ay = cy; az = cz;
        bx = cx + hl; by = cy; bz = cz;
      } else {
        // head: vertical capsule
        r = 0.5 * (ex + ez) * skel.capK[c];
        const hl = Math.max(ey - r, 0);
        const cy = (y0 + y1) / 2;
        ax = cx; ay = cy - hl; az = cz;
        bx = cx; by = cy + hl; bz = cz;
      }
      ma = mb = skel.capA[c] * 12;
    }
    out[o] = M[ma] * ax + M[ma + 1] * ay + M[ma + 2] * az + M[ma + 3];
    out[o + 1] = M[ma + 4] * ax + M[ma + 5] * ay + M[ma + 6] * az + M[ma + 7];
    out[o + 2] = M[ma + 8] * ax + M[ma + 9] * ay + M[ma + 10] * az + M[ma + 11];
    out[o + 3] = M[mb] * bx + M[mb + 1] * by + M[mb + 2] * bz + M[mb + 3];
    out[o + 4] = M[mb + 4] * bx + M[mb + 5] * by + M[mb + 6] * bz + M[mb + 7];
    out[o + 5] = M[mb + 8] * bx + M[mb + 9] * by + M[mb + 10] * bz + M[mb + 11];
    out[o + 6] = r;
  }
  return out;
}

/** LBS of a vertex subset (no corrective) into skel.scratch.pts. */
function skinSubset(skel: Skeleton, M: Float32Array, pos: Float32Array, verts: Uint16Array): Float32Array {
  const out = skel.scratch.pts;
  const so = skel.skinOffset;
  const sw = skel.skinWeight;
  for (let i = 0, o = 0; i < verts.length; i++, o += 3) {
    const v = verts[i];
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let px = 0, py = 0, pz = 0;
    for (let j = 0; j < 4; j++) {
      const w = sw[v * 4 + j];
      if (w === 0) break;
      const m = so[v * 4 + j];
      px += w * (M[m] * x + M[m + 1] * y + M[m + 2] * z + M[m + 3]);
      py += w * (M[m + 4] * x + M[m + 5] * y + M[m + 6] * z + M[m + 7]);
      pz += w * (M[m + 8] * x + M[m + 9] * y + M[m + 10] * z + M[m + 11]);
    }
    out[o] = px; out[o + 1] = py; out[o + 2] = pz;
  }
  return out;
}

/** Extra arm abduction (radians, first order) one side still needs to clear the torso / thigh surface. */
function armNeed(skel: Skeleton, M: Float32Array, pos: Float32Array, joints: Float32Array, side: 'L' | 'R', gap: number, soft: number): number {
  const s = side === 'L' ? 1 : -1;
  const shY = joints[jointIndex(skel, 'upperarm01.' + side) * 3 + 1];
  const y0 = joints[jointIndex(skel, 'lowerleg01.' + side) * 3 + 1] - 0.5;
  const cell = (shY - y0) / GRID;
  const z0 = joints[jointIndex(skel, 'upperleg01.' + side) * 3 + 2] - 0.5 * GRID * cell;
  // outermost torso / thigh x on a (y, z) grid, splatted 3 × 3 so that the vertex sampling leaves no holes
  const grid = skel.scratch.grid.fill(-1e9);
  const torso = skel.probes['torso' + side];
  let P = skinSubset(skel, M, pos, torso);
  for (let i = 0, o = 0; i < torso.length; i++, o += 3) {
    const iy = Math.floor((P[o + 1] - y0) / cell);
    const iz = Math.floor((P[o + 2] - z0) / cell);
    const x = s * P[o];
    for (let yy = iy - 1; yy <= iy + 1; yy++) {
      if (yy < 0 || yy >= GRID) continue;
      for (let zz = iz - 1; zz <= iz + 1; zz++) {
        if (zz < 0 || zz >= GRID) continue;
        if (x > grid[yy * GRID + zz]) grid[yy * GRID + zz] = x;
      }
    }
  }
  let worst = 0;
  for (let pass = 0; pass < 2; pass++) {
    // forearm + hand keep a gap, the upper arm may press into the chest by `soft`
    const verts = skel.probes[(pass === 0 ? 'arm' : 'uarm') + side];
    const g = pass === 0 ? gap : -soft;
    P = skinSubset(skel, M, pos, verts);
    for (let i = 0, o = 0; i < verts.length; i++, o += 3) {
      const iy = Math.floor((P[o + 1] - y0) / cell);
      const iz = Math.floor((P[o + 2] - z0) / cell);
      if (iy < 0 || iy >= GRID || iz < 0 || iz >= GRID) continue;
      const xt = grid[iy * GRID + iz];
      if (xt < -1e8) continue;
      const pen = xt + g - s * P[o];
      if (pen > 0) worst = Math.max(worst, pen / Math.max(shY - P[o + 1], 1));
    }
  }
  return worst;
}

/** Extra leg abduction (radians, first order) one side needs so the thigh crosses the mid-plane by ≤ soft / 2. */
function legNeed(skel: Skeleton, M: Float32Array, pos: Float32Array, joints: Float32Array, side: 'L' | 'R', soft: number): number {
  const s = side === 'L' ? 1 : -1;
  const hipY = joints[jointIndex(skel, 'upperleg01.' + side) * 3 + 1];
  const verts = skel.probes['leg' + side];
  const P = skinSubset(skel, M, pos, verts);
  let worst = 0;
  for (let i = 0, o = 0; i < verts.length; i++, o += 3) {
    const pen = -0.5 * soft - s * P[o];
    if (pen > 0) worst = Math.max(worst, pen / Math.max(hipY - P[o + 1], 1));
  }
  return worst;
}

/**
 * Minimum armAbductionDeg / legAbductionDeg (for t = 1) that keep a morphed body free of self-intersection:
 * forearms + hands clear the torso / hip / thigh surface by `armGapDm`, while the upper arm vs chest and
 * thigh vs thigh may overlap by `softDm` in total (soft tissue touches there on real bodies; use 0 for none).
 * `posDm` = morphed REST mesh, `joints` = computeJoints(skel, posDm) (computed here when omitted). ~0.3 ms.
 */
export function estimateAbduction(
  skel: Skeleton,
  posDm: Float32Array,
  joints?: Float32Array,
  opts: AbductionOptions = {},
): { armAbductionDeg: number; legAbductionDeg: number } {
  const gap = opts.armGapDm ?? 0.1;
  const soft = opts.softDm ?? 0.2;
  const maxArm = opts.maxArmDeg ?? 45;
  const maxLeg = opts.maxLegDeg ?? 20;
  const J = joints ?? computeJoints(skel, posDm, skel.scratch.joints);
  const pose = skel.scratch.pose;
  const o: PoseOptions = { t: 1, armAbductionDeg: 0, legAbductionDeg: 0 };
  let leg = 0;
  for (let it = 0; it < 6; it++) {
    o.legAbductionDeg = leg;
    poseBones(skel, J, o, pose);
    const need = Math.max(legNeed(skel, pose.matrices, posDm, J, 'L', soft), legNeed(skel, pose.matrices, posDm, J, 'R', soft));
    if (need < 1e-4) break;
    leg = Math.min(leg + (need / DEG) * 1.02, maxLeg);
  }
  o.legAbductionDeg = leg;
  let arm = 0;
  for (let it = 0; it < 6; it++) {
    o.armAbductionDeg = arm;
    poseBones(skel, J, o, pose);
    const need = Math.max(armNeed(skel, pose.matrices, posDm, J, 'L', gap, soft), armNeed(skel, pose.matrices, posDm, J, 'R', gap, soft));
    if (need < 1e-4) break;
    arm = Math.min(arm + (need / DEG) * 1.02, maxArm);
  }
  return { armAbductionDeg: arm, legAbductionDeg: leg };
}
