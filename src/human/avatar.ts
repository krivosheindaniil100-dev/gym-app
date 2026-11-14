import type { AvatarSettings, Profile } from '../lib/types';
import type { Composition } from '../lib/energy';
import type { HumanInput } from './fit';
import type { Appearance } from './HumanViewer';

export const DEFAULT_AVATAR: AvatarSettings = {
  skinTone: '#c39880',
  eyeColor: 'brown',
  hairColor: '#2b2119',
  hairStyle: 'buzz',
  ethnic: { african: 0.05, asian: 0.1, caucasian: 0.85 },
  pattern: {},
  shape: {},
  girths: {},
  face: {},
  faceTexture: null,
};

export function avatarOf(p: Profile): AvatarSettings {
  const a = { ...DEFAULT_AVATAR, ...(p.avatar ?? {}) };
  if (!p.avatar?.hairStyle) a.hairStyle = p.sex === 'female' ? 'long01' : 'buzz';
  return a;
}

export function appearanceOf(a: AvatarSettings): Appearance {
  return { skinTone: a.skinTone, eyeColor: a.eyeColor, hairColor: a.hairColor, hairStyle: a.hairStyle, brows: a.brows || null, faceTexture: a.faceTexture, faceLandmarks: a.faceLandmarks, faceMean: a.faceMean };
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

export const SKIN_TONES = ['#edc8b0', '#dcae93', '#c39880', '#a9795c', '#7d5038', '#553529'];
/** iris textures shipped with the model */
export const EYE_OPTIONS: { v: string; l: string; c: string }[] = [
  { v: 'brown', l: 'Карие', c: '#5b3a22' },
  { v: 'brownlight', l: 'Светло-карие', c: '#8a6238' },
  { v: 'green', l: 'Зелёные', c: '#6c7a3c' },
  { v: 'blue', l: 'Голубые', c: '#4f7ca8' },
  { v: 'grey', l: 'Серые', c: '#7f8e9c' },
];
export const HAIR_STYLES: { v: string; l: string }[] = [
  { v: 'buzz', l: 'Под машинку' },
  { v: 'short02', l: 'Короткие' },
  { v: 'none', l: 'Без волос' },
  { v: 'ponytail01', l: 'Хвост' },
  { v: 'long01', l: 'Длинные' },
  { v: 'bob01', l: 'Каре' },
];
export const BROW_OPTIONS: { v: string; l: string }[] = [
  { v: '', l: 'Авто' },
  { v: 'eyebrow001', l: 'Густые' },
  { v: 'eyebrow010', l: 'Тонкие' },
];
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
