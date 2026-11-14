/** Open Food Facts client (product by barcode + text search). */
import type { Food } from './types';

const FIELDS = 'code,product_name,product_name_ru,generic_name_ru,brands,quantity,serving_size,serving_quantity,nutriments,nutrition_data_per,image_front_small_url';

export interface OffResult {
  food: Food;
  servingGrams?: number;
  quality: 'ok' | 'check' | 'incomplete';
  note?: string;
  /** nutrition fields absent in the database (the user has to fill them in) */
  missing?: ('kcal' | 'p' | 'f' | 'c')[];
}

/** Digits only, without leading zeros – so EAN-13 "0012345678905" and UPC-A "012345678905" compare equal. */
export function normBarcode(code: string): string {
  return code.replace(/\D/g, '').replace(/^0+/, '');
}

function n(v: unknown): number | undefined {
  const x = typeof v === 'string' ? Number(v.replace(',', '.')) : (v as number);
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function toFood(p: any): OffResult | null {
  if (!p) return null;
  const nu = p.nutriments ?? {};
  const serving = n(p.serving_quantity);
  const per = (key: string): number | undefined => {
    const v100 = n(nu[`${key}_100g`]);
    if (v100 !== undefined) return v100;
    const vs = n(nu[`${key}_serving`]);
    if (vs !== undefined && serving) return (vs / serving) * 100;
    return undefined;
  };
  let kcal = per('energy-kcal');
  if (kcal === undefined) {
    const kj = per('energy');
    if (kj !== undefined) kcal = kj / 4.184;
  }
  const p_ = per('proteins');
  const f_ = per('fat');
  const c_ = per('carbohydrates');
  const fiber = per('fiber');
  const name = (p.product_name_ru || p.product_name || p.generic_name_ru || '').trim();
  if (!name && kcal === undefined) return null;
  let quality: OffResult['quality'] = 'ok';
  let note: string | undefined;
  // kcal alone can be derived from the macros
  if (kcal === undefined && p_ !== undefined && f_ !== undefined && c_ !== undefined) kcal = 4 * p_ + 9 * f_ + 4 * c_ + 2 * (fiber ?? 0);
  const missing: NonNullable<OffResult['missing']> = [];
  if (kcal === undefined) missing.push('kcal');
  if (p_ === undefined) missing.push('p');
  if (f_ === undefined) missing.push('f');
  if (c_ === undefined) missing.push('c');
  if (missing.length) {
    quality = 'incomplete';
    note = 'В базе не хватает части КБЖУ — проверьте по этикетке.';
  } else {
    const calc = 4 * p_! + 9 * f_! + 4 * c_! + 2 * (fiber ?? 0);
    if (kcal! > 0 && Math.abs(calc - kcal!) / kcal! > 0.2) {
      quality = 'check';
      note = `Калорийность (${Math.round(kcal!)}) не сходится с БЖУ (${Math.round(calc)}) — сверьте с этикеткой.`;
    }
  }
  const food: Food = {
    id: `off_${p.code}`,
    name: name || 'Без названия',
    brand: (p.brands || '').split(',')[0]?.trim() || undefined,
    barcode: String(p.code),
    category: 'other',
    per100: {
      kcal: Math.round((kcal ?? 0) * 10) / 10,
      p: Math.round((p_ ?? 0) * 10) / 10,
      f: Math.round((f_ ?? 0) * 10) / 10,
      c: Math.round((c_ ?? 0) * 10) / 10,
      fiber: fiber !== undefined ? Math.round(fiber * 10) / 10 : undefined,
    },
    units: serving ? [{ label: `порция (${p.serving_size || serving + ' г'})`, grams: serving }] : undefined,
    source: 'off',
    imageUrl: p.image_front_small_url,
  };
  return { food, servingGrams: serving && serving > 0 && serving < 2000 ? serving : undefined, quality, note, missing: missing.length ? missing : undefined };
}

async function getJson(url: string, timeoutMs = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 404) return null; // unknown product is an answer, not a network failure
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchByBarcode(code: string): Promise<OffResult | null> {
  const clean = code.replace(/\D/g, '');
  if (!clean) return null;
  const j = await getJson(`https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=${FIELDS}`);
  if (!j || j.status === 0 || !j.product) return null;
  return toFood({ ...j.product, code: j.product.code || clean });
}

export async function searchOff(query: string): Promise<OffResult[]> {
  const q = encodeURIComponent(query.trim());
  const j = await getJson(
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=24&lc=ru&sort_by=unique_scans_n&fields=${FIELDS}`,
    12000,
  );
  const arr: any[] = j?.products ?? [];
  return arr.map(toFood).filter((x): x is OffResult => !!x && x.quality !== 'incomplete' && x.food.per100.kcal > 0);
}
