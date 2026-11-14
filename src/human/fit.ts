/**
 * Body composition → realistic human shape.
 *
 * 1. Macro parameters (gender, age, muscle, weight) from FFMI and body-fat %.
 * 2. Regional shape targets from the physical fat-depot model (glutes, belly/visceral, breasts, limbs, double chin).
 * 3. Girth fitting: the realistic mesh's tape-measure loops are driven so that their RELATIVE change matches the
 *    volume-based physics model (src/body/model.ts) – and, if the user entered tape measurements / photo fit,
 *    their personal offsets.
 */
import { buildBody, REFS, type BodyInput, type BodyInfo } from '../body/model';
import { measureBody } from '../body/measure';
import { addModifiers, applyTargets, loopLength, macroWeights, RULER, RULER_TARGET, resolveModifier, type HumanData, type MacroParams, type Modifiers } from './engine';

export type GirthKey = 'neck' | 'chest' | 'waist' | 'hips' | 'thigh' | 'calf' | 'arm';
export const GIRTH_KEYS: GirthKey[] = ['neck', 'chest', 'waist', 'hips', 'thigh', 'calf', 'arm'];
export const GIRTH_LABEL: Record<GirthKey, string> = {
  neck: 'Шея',
  chest: 'Грудь',
  waist: 'Талия',
  hips: 'Бёдра (ягодицы)',
  thigh: 'Бедро',
  calf: 'Голень',
  arm: 'Плечо (бицепс)',
};

/** A personal tape measurement taken at a known body composition. */
export interface PersonalGirth {
  cm: number;
  fatKg: number; // total fat at the moment of measuring
  /** 0..1 how much of the personal excess is fat (shrinks when fat goes) */
  fatShare: number;
}

export interface Persona {
  ethnic?: { african: number; asian: number; caucasian: number };
  girths?: Partial<Record<GirthKey, PersonalGirth>>;
  /** extra face / body modifiers fitted from photos */
  modifiers?: Modifiers;
  /** body-shape modifiers (bodyshapes-elvs-*) */
  shape?: Modifiers;
}

export interface HumanInput extends BodyInput {
  persona?: Persona;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function ageParam(age = 30) {
  if (age <= 25) return clamp(0.1875 + ((age - 10) / 15) * 0.3125, 0.19, 0.5);
  return clamp(0.5 + ((age - 25) / 65) * 0.5, 0.5, 1);
}

export function macroFor(input: HumanInput): MacroParams {
  const h = input.heightCm / 100;
  const ffmi = input.ffm / (h * h);
  const bf = (input.fatKg / input.weight) * 100;
  const male = input.sex === 'male';
  const muscle = male ? clamp(0.5 + (ffmi - 19.5) / 9, 0.05, 1) : clamp(0.5 + (ffmi - 15.8) / 8, 0.05, 1);
  const weight = male ? clamp(0.5 + (bf - 18) / 28, 0, 1) : clamp(0.5 + (bf - 27) / 28, 0, 1);
  return {
    gender: male ? 1 : 0,
    age: ageParam(input.age),
    muscle,
    weight,
    breastSize: 0.5,
    ethnic: input.persona?.ethnic ?? { african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 },
  };
}

/** Reference composition (population average) for the user's height and sex. */
export function referenceInput(input: HumanInput): HumanInput {
  const ref = REFS[input.sex];
  const k = (input.heightCm / ref.H) ** 2;
  const ffm = ref.ffm * k;
  const fat = ref.fat * k;
  return { ...input, ffm, fatKg: fat, weight: ffm + fat, smm: ref.smm * k, pattern: undefined, persona: undefined };
}

function regionalModifiers(input: HumanInput, info: BodyInfo, refInfo: BodyInfo): Modifiers {
  const z = info.zoneFat;
  const r = refInfo.zoneFat;
  const male = input.sex === 'male';
  const rel = (a: number, b: number) => (b > 0.01 ? a / b - 1 : 0);
  const mus = info.muscleScale - 1;
  const mods: Modifiers = {
    'buttocks/buttocks-volume': clamp(rel(z.glutes, r.glutes) * 0.55, -0.8, 1),
    'armslegs/l-upperarm-fat': clamp(rel(z.upperArm, r.upperArm) * 0.5, -1, 1),
    'armslegs/r-upperarm-fat': clamp(rel(z.upperArm, r.upperArm) * 0.5, -1, 1),
    'armslegs/l-upperleg-fat': clamp(rel(z.thigh, r.thigh) * 0.45, -1, 1),
    'armslegs/r-upperleg-fat': clamp(rel(z.thigh, r.thigh) * 0.45, -1, 1),
    'armslegs/l-lowerleg-fat': clamp(rel(z.calf, r.calf) * 0.4, -1, 1),
    'armslegs/r-lowerleg-fat': clamp(rel(z.calf, r.calf) * 0.4, -1, 1),
    'armslegs/l-upperarm-muscle': clamp(mus * 2.2, -1, 1),
    'armslegs/r-upperarm-muscle': clamp(mus * 2.2, -1, 1),
    'armslegs/l-upperarm-shoulder-muscle': clamp(mus * 2.2, -1, 1),
    'armslegs/r-upperarm-shoulder-muscle': clamp(mus * 2.2, -1, 1),
    'armslegs/l-upperleg-muscle': clamp(mus * 1.8, -1, 1),
    'armslegs/r-upperleg-muscle': clamp(mus * 1.8, -1, 1),
    'armslegs/l-lowerleg-muscle': clamp(mus * 1.6, -1, 1),
    'armslegs/r-lowerleg-muscle': clamp(mus * 1.6, -1, 1),
    'torso/torso-muscle-pectoral': clamp(mus * 2, -1, 1),
    'torso/torso-muscle-dorsi': clamp(mus * 2, -1, 1),
    'neck/neck-double': clamp((info.faceFatMm - 6) / 9, -0.3, 1),
    // visceral fat → firm, protruding belly
    'stomach/stomach-pregnant': clamp((info.vat - (male ? 1.6 : 1.1)) / (male ? 5 : 4), -0.25, 0.9),
  };
  return mods;
}

export interface FitResult {
  pos: Float32Array; // decimetres, all vertices
  weights: Map<string, number>;
  girths: Record<string, number>; // cm on the final mesh
  info: BodyInfo;
  scale: number; // decimetre → metre incl. height scaling
  offset: [number, number, number];
}

const physCache = new Map<string, Record<string, number>>();
function physicsGirths(input: BodyInput): { g: Record<string, number>; info: BodyInfo } {
  const spec = buildBody(input);
  const key = JSON.stringify([input.sex, input.heightCm, input.fatKg.toFixed(2), input.ffm.toFixed(2), (input.smm ?? 0).toFixed(2), input.pattern ?? null]);
  let g = physCache.get(key);
  if (!g) {
    g = {};
    for (const m of measureBody(spec)) g[m.key] = m.cm;
    physCache.set(key, g);
    if (physCache.size > 200) physCache.delete(physCache.keys().next().value!);
  }
  return { g, info: spec.info };
}

// physics girth key used for each ruler loop
const PHYS_KEY: Record<string, string> = { neck: 'neck', chest: 'chest', waist: 'waist', hips: 'hips', thigh: 'thigh', calf: 'calf', arm: 'arm' };

function bodyFrame(data: HumanData, pos: Float32Array, heightCm: number) {
  // body vertices only
  const body = data.faces.body;
  let minY = Infinity,
    maxY = -Infinity,
    cx = 0,
    cz = 0;
  const seen = new Uint8Array(data.nVerts);
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const v = body[i];
    if (seen[v]) continue;
    seen[v] = 1;
    const y = pos[v * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    cx += pos[v * 3];
    cz += pos[v * 3 + 2];
    n++;
  }
  const s = heightCm / 100 / (maxY - minY);
  return { scale: s, offset: [-(cx / n) * s, -minY * s, -(cz / n) * s] as [number, number, number] };
}

const jacCache = new Map<string, Record<string, number>>();

/** Full fit for one composition. Pure function of input (cached Jacobian per sex/height). */
export function fitHuman(data: HumanData, input: HumanInput): FitResult {
  const macro = macroFor(input);
  const refIn = referenceInput(input);
  const phys = physicsGirths(input);
  const physRef = physicsGirths(refIn);

  // female breast size from breast fat volume
  if (input.sex === 'female') {
    const r = physRef.info.zoneFat.breasts;
    macro.breastSize = clamp(0.5 + (phys.info.zoneFat.breasts / Math.max(r, 0.05) - 1) * 0.35, 0.05, 1);
  }

  const mods: Modifiers = { ...regionalModifiers(input, phys.info, physRef.info), ...(input.persona?.shape ?? {}), ...(input.persona?.modifiers ?? {}) };
  const baseWeights = addModifiers(data, macroWeights(macro), mods);

  // reference mesh girths (average person of this height) → absolute anchor
  const refMacro = macroFor(refIn);
  const refWeights = macroWeights(refMacro);
  const refPos = applyTargets(data, refWeights);
  const refFrame = bodyFrame(data, refPos, input.heightCm);
  const refG: Record<string, number> = {};
  for (const k of Object.keys(PHYS_KEY)) refG[k] = loopLength(refPos, RULER[k], refFrame.scale * 100);

  // targets
  const target: Record<string, number> = {};
  for (const k of Object.keys(PHYS_KEY)) {
    const pk = PHYS_KEY[k];
    let t = refG[k] * (phys.g[pk] / physRef.g[pk]);
    const pg = input.persona?.girths?.[k as GirthKey];
    if (pg) {
      // personal ratio measured at composition `pg.fatKg`; its fat part scales with current fat
      const atMeas = physicsGirths({ ...input, fatKg: pg.fatKg, weight: input.ffm + pg.fatKg });
      const modelAtMeas = refG[k] * (atMeas.g[pk] / physRef.g[pk]);
      const ratio = pg.cm / modelAtMeas;
      const fatScale = input.fatKg / Math.max(pg.fatKg, 1);
      const r = 1 + (ratio - 1) * (pg.fatShare * fatScale + (1 - pg.fatShare));
      t *= r;
    }
    target[k] = t;
  }

  // Jacobian of each loop w.r.t. its measure target (diagonal approximation)
  const jKey = `${input.sex}|${Math.round(input.heightCm)}`;
  let J = jacCache.get(jKey);
  if (!J) {
    J = {};
    const p0 = applyTargets(data, refWeights);
    const fr = bodyFrame(data, p0, input.heightCm);
    for (const k of Object.keys(PHYS_KEY)) {
      const w = new Map(refWeights);
      const r = resolveModifier(data, RULER_TARGET[k], 1)!;
      w.set(r[0], 1);
      const p1 = applyTargets(data, w);
      const r2 = resolveModifier(data, RULER_TARGET[k], -1)!;
      const w2 = new Map(refWeights);
      w2.set(r2[0], 1);
      const p2 = applyTargets(data, w2);
      J[k] = (loopLength(p1, RULER[k], fr.scale * 100) - loopLength(p2, RULER[k], fr.scale * 100)) / 2;
    }
    jacCache.set(jKey, J);
  }

  // iterate: girth correction values
  const corr: Record<string, number> = {};
  let pos = applyTargets(data, baseWeights);
  let frame = bodyFrame(data, pos, input.heightCm);
  for (let it = 0; it < 3; it++) {
    for (const k of Object.keys(PHYS_KEY)) {
      const g = loopLength(pos, RULER[k], frame.scale * 100);
      corr[k] = clamp((corr[k] ?? 0) + ((target[k] - g) / J[k]) * 0.9, -2.2, 2.2);
    }
    const w = new Map(baseWeights);
    for (const k of Object.keys(PHYS_KEY)) {
      const r = resolveModifier(data, RULER_TARGET[k], corr[k]);
      if (r) w.set(r[0], (w.get(r[0]) ?? 0) + r[1]);
    }
    pos = applyTargets(data, w, pos);
    frame = bodyFrame(data, pos, input.heightCm);
    if (it === 2) {
      const girths: Record<string, number> = {};
      for (const k of Object.keys(PHYS_KEY)) girths[k] = loopLength(pos, RULER[k], frame.scale * 100);
      return { pos, weights: w, girths, info: phys.info, scale: frame.scale, offset: frame.offset };
    }
  }
  throw new Error('unreachable');
}
