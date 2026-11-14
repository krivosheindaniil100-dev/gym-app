/**
 * Universal parser for body-composition QR codes (medical / smart scales).
 * Supports JSON, URLs with query parameters, key=value text, and plain number lists
 * (with a learned positional mapping, remembered per "signature").
 */
export type MField = 'weight' | 'fatPct' | 'fatKg' | 'smm' | 'ffm' | 'water' | 'visceral' | 'bmr' | 'height' | 'age';

export const FIELD_LABEL: Record<MField, string> = {
  weight: 'Вес, кг',
  fatPct: 'Жир, %',
  fatKg: 'Жир, кг',
  smm: 'Скелетные мышцы, кг',
  ffm: 'Безжировая масса, кг',
  water: 'Вода, кг',
  visceral: 'Висцеральный жир (уровень)',
  bmr: 'Базовый обмен, ккал',
  height: 'Рост, см',
  age: 'Возраст',
};

const SYN: Record<MField, string[]> = {
  weight: ['weight', 'wt', 'w', 'bw', 'bodyweight', 'вес', 'масса', 'mass', 'kg'],
  fatPct: ['pbf', 'bf', 'bfp', 'fat%', 'fatpct', 'fatpercent', 'bodyfat', 'percentbodyfat', 'fatp', 'fatrate', 'жир%', 'процентжира', 'pbfm'],
  fatKg: ['bfm', 'fatmass', 'fatkg', 'fm', 'bodyfatmass', 'жирмасса', 'масса жира', 'fat'],
  smm: ['smm', 'skeletalmuscle', 'skeletalmusclemass', 'sm', 'muscle', 'musclemass', 'мышцы', 'скелетныемышцы', 'mm'],
  ffm: ['ffm', 'lbm', 'fatfree', 'fatfreemass', 'leanmass', 'lean', 'бжм', 'тощаямасса'],
  water: ['tbw', 'water', 'bodywater', 'вода', 'totalbodywater'],
  visceral: ['vfl', 'visceral', 'vfa', 'vf', 'visceralfat', 'висцеральный', 'vfi'],
  bmr: ['bmr', 'basalmetabolicrate', 'обмен', 'основнойобмен'],
  height: ['height', 'ht', 'h', 'рост'],
  age: ['age', 'возраст'],
};

const DATE_KEYS = ['date', 'dt', 'time', 'datetime', 'measuredate', 'testdate', 'дата', 'mdate', 'ts', 'timestamp'];

const norm = (k: string) => k.toLowerCase().replace(/[\s_\-.]/g, '');

function fieldFor(key: string): MField | 'date' | null {
  const n = norm(key);
  if (DATE_KEYS.includes(n)) return 'date';
  for (const f of Object.keys(SYN) as MField[]) {
    if (SYN[f].some((s) => norm(s) === n)) return f;
  }
  return null;
}

/** Accept a date only if it is real, not in the future (+5 min tolerance) and not absurdly old. */
function validDate(d: Date): string | undefined {
  const t = d.getTime();
  if (!Number.isFinite(t)) return undefined;
  if (t > Date.now() + 5 * 60000 || d.getFullYear() < 2015) return undefined;
  return d.toISOString();
}

function ymd(y: number, m: number, d: number, hh = 9, mm = 0): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return undefined;
  const dt = new Date(y, m - 1, d, hh, mm);
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return undefined; // e.g. 31 February
  return validDate(dt);
}

export function parseDateLoose(v: string): string | undefined {
  const s = v.trim();
  if (!s) return undefined;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return validDate(new Date(s.length === 13 ? n : n * 1000));
  }
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/);
  if (m) return ymd(+m[1], +m[2], +m[3], +(m[4] ?? 9), +(m[5] ?? 0));
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let day = +m[1];
    let mon = +m[2];
    if (mon > 12 && day <= 12) [day, mon] = [mon, day]; // US-style month/day
    return ymd(y, mon, day, +(m[4] ?? 9), +(m[5] ?? 0));
  }
  const d = new Date(s.replace(' ', 'T'));
  return validDate(d);
}

export interface QrParse {
  kind: 'json' | 'url' | 'kv' | 'numbers' | 'unknown';
  fields: Partial<Record<MField, number>>;
  date?: string;
  numbers: number[];
  signature: string;
  raw: string;
  host?: string;
  /** URL without data – only a link to a cloud service */
  linkOnly: boolean;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return undefined;
};

function fromPairs(pairs: [string, unknown][], out: QrParse) {
  for (const [k, v] of pairs) {
    const f = fieldFor(k);
    if (!f) continue;
    if (f === 'date') {
      const d = parseDateLoose(String(v));
      if (d) out.date = d;
      continue;
    }
    const n = num(v);
    if (n !== undefined && out.fields[f] === undefined) out.fields[f] = n;
  }
}

function flatten(obj: unknown, prefix = '', acc: [string, unknown][] = []): [string, unknown][] {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === 'object') flatten(v, k, acc);
      else acc.push([k, v]);
      if (prefix) acc.push([prefix + k, v]);
    }
  }
  return acc;
}

export function numbersSignature(raw: string, numbers: number[]) {
  const delim = (raw.match(/[;|,\t ]/g) ?? []).slice(0, 3).join('');
  return `n${numbers.length}:${delim}:${raw.slice(0, 3).replace(/\d/g, '#')}`;
}

export function parseQr(raw: string, learned?: Record<string, Partial<Record<MField, number>>>): QrParse {
  const text = raw.trim();
  const numbers = (text.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((s) => Number(s.replace(',', '.')));
  const out: QrParse = { kind: 'unknown', fields: {}, numbers, signature: numbersSignature(text, numbers), raw: text, linkOnly: false };

  // JSON
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      out.kind = 'json';
      fromPairs(flatten(JSON.parse(text)), out);
      return out;
    } catch {
      /* not json */
    }
  }
  // URL
  if (/^https?:\/\//i.test(text)) {
    out.kind = 'url';
    try {
      const u = new URL(text);
      out.host = u.host;
      const pairs: [string, unknown][] = [];
      u.searchParams.forEach((v, k) => pairs.push([k, v]));
      // hash params too
      if (u.hash.includes('=')) new URLSearchParams(u.hash.slice(1)).forEach((v, k) => pairs.push([k, v]));
      fromPairs(pairs, out);
      // maybe one param contains the payload (e.g. data=...)
      if (Object.keys(out.fields).length === 0) {
        for (const [, v] of pairs) {
          const inner = String(v);
          if (inner.length > 10) {
            let decoded = inner;
            try {
              decoded = decodeURIComponent(inner);
            } catch {
              /* ignore */
            }
            try {
              decoded = atob(decoded);
            } catch {
              /* not base64 */
            }
            const sub = parseQr(decoded, learned);
            if (Object.keys(sub.fields).length) {
              out.fields = sub.fields;
              out.date = sub.date;
              break;
            }
          }
        }
      }
      out.linkOnly = Object.keys(out.fields).length === 0;
    } catch {
      /* bad url */
    }
    return out;
  }
  // key=value / key:value
  const kv = [...text.matchAll(/([A-Za-zА-Яа-я_%][\wА-Яа-я%. -]{0,30}?)\s*[=:]\s*([^;&|\n\r,]+)/g)];
  if (kv.length >= 2) {
    out.kind = 'kv';
    fromPairs(
      kv.map((m) => [m[1].trim(), m[2].trim()]),
      out,
    );
    if (Object.keys(out.fields).length) return out;
  }
  // plain numbers – use learned positional mapping
  if (numbers.length >= 2) {
    out.kind = 'numbers';
    const map = learned?.[out.signature];
    if (map) {
      for (const [f, idx] of Object.entries(map) as [MField, number][]) {
        if (numbers[idx] !== undefined) out.fields[f] = numbers[idx];
      }
    }
    const d = text.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?|\d{1,2}\.\d{1,2}\.\d{4}(?: \d{1,2}:\d{2})?|\b20\d{6}(?:\d{4})?\b/);
    if (d) out.date = parseDateLoose(d[0]);
  }
  return out;
}

export interface CompletedMeasurement {
  weight: number;
  fatPct: number;
  fatKg: number;
  ffm: number;
  smm?: number;
  water?: number;
  visceral?: number;
  bmr?: number;
}

/** Fill derived fields; returns null if weight or fat are missing / implausible. */
export function completeFields(f: Partial<Record<MField, number>>): CompletedMeasurement | null {
  const weight = f.weight;
  if (!weight || weight < 25 || weight > 350) return null;
  let fatKg = f.fatKg;
  let fatPct = f.fatPct;
  if (fatPct === undefined && fatKg !== undefined) fatPct = (fatKg / weight) * 100;
  if (fatKg === undefined && fatPct !== undefined) fatKg = (weight * fatPct) / 100;
  if (fatKg === undefined && f.ffm !== undefined) {
    fatKg = weight - f.ffm;
    fatPct = (fatKg / weight) * 100;
  }
  if (fatKg === undefined || fatPct === undefined || fatPct < 2 || fatPct > 70) return null;
  const ffm = f.ffm ?? weight - fatKg;
  return { weight, fatPct, fatKg, ffm, smm: f.smm, water: f.water, visceral: f.visceral, bmr: f.bmr };
}

/** Our own QR format (to share measurements between devices or create test codes). */
export function encodeOwnQr(m: { date: string; weight: number; fatPct: number; smm?: number; visceral?: number }) {
  return `BT1;date=${m.date};weight=${m.weight};pbf=${m.fatPct}${m.smm ? `;smm=${m.smm}` : ''}${m.visceral ? `;vfl=${m.visceral}` : ''}`;
}
