import type { AvatarSettings, Profile } from '../lib/types';
import type { Composition } from '../lib/energy';
import type { HumanInput } from './fit';
import type { Appearance } from './HumanViewer';

export const DEFAULT_AVATAR: AvatarSettings = {
  skinTone: '#c9906f',
  eyeColor: '#5b4632',
  hairColor: '#2b2119',
  hairStyle: 'short',
  ethnic: { african: 0.05, asian: 0.1, caucasian: 0.85 },
  pattern: {},
  shape: {},
  girths: {},
  face: {},
  faceTexture: null,
};

export function avatarOf(p: Profile): AvatarSettings {
  return { ...DEFAULT_AVATAR, ...(p.avatar ?? {}) };
}

export function appearanceOf(a: AvatarSettings): Appearance {
  return { skinTone: a.skinTone, eyeColor: a.eyeColor, hairColor: a.hairColor, hairStyle: a.hairStyle, faceTexture: a.faceTexture, faceLandmarks: a.faceLandmarks, faceMean: a.faceMean };
}

export function humanInputFor(p: Profile, c: Composition): HumanInput {
  const a = avatarOf(p);
  const r = (v: number, s: number) => Math.round(v / s) * s;
  const pattern = Object.keys(a.pattern).length ? a.pattern : undefined;
  const girths = Object.fromEntries(Object.entries(a.girths).map(([k, g]) => [k, { cm: g!.cm, fatKg: g!.fatKg, fatShare: g!.fatShare }]));
  return {
    sex: p.sex,
    heightCm: p.heightCm,
    age: new Date().getFullYear() - p.birthYear,
    weight: r(c.weight, 0.01),
    fatKg: r(c.fatKg, 0.01),
    ffm: r(c.ffm, 0.01),
    smm: r(c.smm, 0.01),
    pattern,
    persona: {
      ethnic: a.ethnic,
      girths: Object.keys(girths).length ? girths : undefined,
      shape: Object.keys(a.shape).length ? a.shape : undefined,
      modifiers: Object.keys(a.face).length ? a.face : undefined,
    },
  };
}

/** How much of a personal girth excess is fat (default per zone). */
export const FAT_SHARE: Record<string, number> = { neck: 0.4, chest: 0.5, waist: 0.85, hips: 0.7, thigh: 0.6, calf: 0.3, arm: 0.5 };

export const SKIN_TONES = ['#f1c7aa', '#e0ac8b', '#c9906f', '#a86e4f', '#7f4f35', '#56352a'];
export const EYE_COLORS = ['#5b4632', '#3b2a1e', '#6c7a3c', '#4f7ca8', '#7f8e9c', '#2a1b12'];
export const HAIR_COLORS = ['#141010', '#2b2119', '#4a3222', '#7a5434', '#b08a5a', '#8a8a8a'];

export const BODY_SHAPES: Record<'male' | 'female', { key: string; label: string; hint: string }[]> = {
  male: [
    { key: 'bodyshapes/bodyshapes-elvs-man-trapezoid', label: 'Трапеция', hint: 'широкие плечи, узкий таз' },
    { key: 'bodyshapes/bodyshapes-elvs-man-invert-triangle', label: 'Перевёрнутый треугольник', hint: 'очень широкая грудь и плечи' },
    { key: 'bodyshapes/bodyshapes-elvs-man-rectangle', label: 'Прямоугольник', hint: 'плечи ≈ талия ≈ бёдра' },
    { key: 'bodyshapes/bodyshapes-elvs-man-triangle', label: 'Треугольник (груша)', hint: 'жир в бёдрах и ягодицах' },
    { key: 'bodyshapes/bodyshapes-elvs-man-apple', label: 'Яблоко', hint: 'жир в животе' },
  ],
  female: [
    { key: 'bodyshapes/bodyshapes-elvs-fem-full-hourglass', label: 'Песочные часы', hint: 'грудь ≈ бёдра, узкая талия' },
    { key: 'bodyshapes/bodyshapes-elvs-fem-triangle', label: 'Груша', hint: 'бёдра шире плеч' },
    { key: 'bodyshapes/bodyshapes-elvs-fem-apple', label: 'Яблоко', hint: 'жир в животе' },
    { key: 'bodyshapes/bodyshapes-elvs-fem-rectangle', label: 'Прямоугольник', hint: 'ровный силуэт' },
    { key: 'bodyshapes/bodyshapes-elvs-fem-invert-triangle', label: 'Перевёрнутый треугольник', hint: 'плечи шире бёдер' },
  ],
};

export const ZONES: { key: keyof AvatarSettings['pattern']; label: string }[] = [
  { key: 'belly', label: 'Живот' },
  { key: 'flanks', label: 'Бока' },
  { key: 'glutes', label: 'Ягодицы' },
  { key: 'hips', label: 'Бёдра сбоку' },
  { key: 'thighs', label: 'Ноги (бёдра)' },
  { key: 'chest', label: 'Грудь' },
  { key: 'back', label: 'Спина' },
  { key: 'arms', label: 'Руки' },
];
