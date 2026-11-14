/**
 * "What can I cook?" – picks recipes and scales portions (in grams) to hit target macros.
 */
import { FOODS } from '../data/foods';
import { RECIPES } from '../data/recipes';
import type { DietFlag, Food, FoodPrefs, MealSlot, Per100, Recipe } from './types';

const FOOD_MAP = new Map<string, Food>(FOODS.map((f) => [f.id, f]));
export const foodById = (id: string) => FOOD_MAP.get(id);

export interface RecipeInfo {
  recipe: Recipe;
  /** whole recipe totals */
  total: { kcal: number; p: number; f: number; c: number; fiber: number; grams: number };
  serving: { kcal: number; p: number; f: number; c: number; grams: number };
  per100: Per100;
  flags: Set<DietFlag>;
  categories: Set<string>;
}

let cache: RecipeInfo[] | null = null;

export function recipeInfos(): RecipeInfo[] {
  if (cache) return cache;
  cache = RECIPES.map((r) => {
    const t = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0, grams: 0 };
    const flags = new Set<DietFlag>();
    const categories = new Set<string>();
    for (const ing of r.ingredients) {
      const f = FOOD_MAP.get(ing.foodId);
      if (!f) continue;
      const k = ing.grams / 100;
      t.kcal += f.per100.kcal * k;
      t.p += f.per100.p * k;
      t.f += f.per100.f * k;
      t.c += f.per100.c * k;
      t.fiber += (f.per100.fiber ?? 0) * k;
      t.grams += ing.grams;
      f.flags?.forEach((x) => flags.add(x));
      categories.add(f.category);
    }
    const grams = r.yieldGrams ?? t.grams;
    const per100: Per100 = {
      kcal: (t.kcal / grams) * 100,
      p: (t.p / grams) * 100,
      f: (t.f / grams) * 100,
      c: (t.c / grams) * 100,
      fiber: (t.fiber / grams) * 100,
    };
    const s = r.servings || 1;
    return {
      recipe: r,
      total: { ...t, grams },
      serving: { kcal: t.kcal / s, p: t.p / s, f: t.f / s, c: t.c / s, grams: grams / s },
      per100,
      flags,
      categories,
    };
  });
  return cache;
}

export function allowedByPrefs(ri: RecipeInfo, prefs: FoodPrefs): boolean {
  const fl = ri.flags;
  if (prefs.diet === 'vegetarian' && (fl.has('meat') || fl.has('fish') || fl.has('seafood') || fl.has('pork') || fl.has('beef'))) return false;
  if (prefs.diet === 'pescatarian' && (fl.has('meat') || fl.has('pork') || fl.has('beef'))) return false;
  if (prefs.diet === 'no_pork' && fl.has('pork')) return false;
  for (const x of prefs.exclude) if (fl.has(x)) return false;
  if (ri.recipe.minutes > prefs.maxCookMinutes) return false;
  return true;
}

function likeScore(ri: RecipeInfo, prefs: FoodPrefs) {
  let s = 0;
  for (const c of prefs.likes) if (ri.categories.has(c)) s += 1;
  if (prefs.sweetTooth && ri.recipe.tags.includes('сладкое')) s += 1.5;
  return s;
}

export interface MacroTarget {
  kcal: number;
  p: number;
  f: number;
  c: number;
}

export interface Suggestion {
  info: RecipeInfo;
  grams: number;
  macros: MacroTarget;
  fit: number; // 0..100
}

const W = { p: 1.6, f: 1.0, c: 0.8, kcal: 1.2 };

function errFor(m: MacroTarget, t: MacroTarget) {
  const rel = (a: number, b: number) => (a - b) / Math.max(b, 10);
  return W.kcal * rel(m.kcal, t.kcal) ** 2 + W.p * rel(m.p, t.p) ** 2 + W.f * rel(m.f, t.f) ** 2 + W.c * rel(m.c, t.c) ** 2;
}

/** Best single dishes for a target (e.g. "what to eat now" with what's left of the day). */
export function suggestDishes(target: MacroTarget, prefs: FoodPrefs, slot?: MealSlot, limit = 12): Suggestion[] {
  const out: Suggestion[] = [];
  for (const ri of recipeInfos()) {
    if (!allowedByPrefs(ri, prefs)) continue;
    if (slot && !ri.recipe.slots.includes(slot)) continue;
    const p100 = ri.per100;
    // optimal grams g: minimize weighted relative error → closed form least squares
    const terms: [number, number, number][] = [
      [p100.kcal / 100, target.kcal, W.kcal],
      [p100.p / 100, target.p, W.p],
      [p100.f / 100, target.f, W.f],
      [p100.c / 100, target.c, W.c],
    ];
    let num = 0,
      den = 0;
    for (const [a, t, w] of terms) {
      const s = Math.max(t, 10);
      num += (w * a * t) / (s * s);
      den += (w * a * a) / (s * s);
    }
    let g = den > 0 ? num / den : ri.serving.grams;
    g = Math.max(ri.serving.grams * 0.6, Math.min(ri.serving.grams * 1.8, g));
    g = Math.round(g / 10) * 10;
    const macros = { kcal: (p100.kcal * g) / 100, p: (p100.p * g) / 100, f: (p100.f * g) / 100, c: (p100.c * g) / 100 };
    const e = errFor(macros, target);
    const fit = Math.max(0, 100 * (1 - Math.sqrt(e / 4.6)));
    out.push({ info: ri, grams: g, macros, fit: fit + likeScore(ri, prefs) * 2 });
  }
  return out.sort((a, b) => b.fit - a.fit).slice(0, limit).map((s) => ({ ...s, fit: Math.min(100, s.fit) }));
}

export interface DayPlanMeal {
  slot: MealSlot;
  info: RecipeInfo;
  grams: number;
  macros: MacroTarget;
}
export interface DayPlan {
  meals: DayPlanMeal[];
  total: MacroTarget;
  fit: number;
}

const SLOT_SETS: Record<number, MealSlot[]> = {
  1: ['dinner'],
  2: ['lunch', 'dinner'],
  3: ['breakfast', 'lunch', 'dinner'],
  4: ['breakfast', 'lunch', 'snack', 'dinner'],
  5: ['breakfast', 'snack', 'lunch', 'snack', 'dinner'],
};

/** Plan several meals that together match the target. Returns a few diverse variants. */
export const slotsForMeals = (meals: number): MealSlot[] => SLOT_SETS[Math.max(1, Math.min(5, meals))];

/** @param meals number of meals, or the explicit list of slots still to be eaten */
export function planDay(target: MacroTarget, prefs: FoodPrefs, meals: number | MealSlot[], variants = 3, seed = Date.now()): DayPlan[] {
  const slots = Array.isArray(meals) ? meals : slotsForMeals(meals);
  if (!slots.length || !(target.kcal > 50)) return [];
  let rnd = seed % 2147483647;
  const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  const pools = slots.map((sl) => recipeInfos().filter((ri) => allowedByPrefs(ri, prefs) && ri.recipe.slots.includes(sl)));
  if (pools.some((p) => p.length === 0)) return [];
  // share of the day per slot
  const share: Record<MealSlot, number> = { breakfast: 0.27, lunch: 0.33, dinner: 0.3, snack: 0.12 };
  const shareSum = slots.reduce((s, x) => s + share[x], 0);
  const candidates: DayPlan[] = [];
  for (let trial = 0; trial < 260; trial++) {
    const pick: RecipeInfo[] = [];
    for (let i = 0; i < slots.length; i++) {
      const pool = pools[i];
      // bias towards liked recipes
      let best = pool[Math.floor(rand() * pool.length)];
      const alt = pool[Math.floor(rand() * pool.length)];
      if (likeScore(alt, prefs) > likeScore(best, prefs) && rand() < 0.6) best = alt;
      if (pick.some((p) => p.recipe.id === best.recipe.id)) best = pool[Math.floor(rand() * pool.length)];
      pick.push(best);
    }
    // initial grams: slot share of target kcal
    const g = pick.map((ri, i) => (target.kcal * (share[slots[i]] / shareSum) * 100) / Math.max(ri.per100.kcal, 30));
    const lo = pick.map((ri) => ri.serving.grams * 0.6);
    const hi = pick.map((ri, i) => ri.serving.grams * (slots[i] === 'snack' ? 1.3 : 1.7));
    const slotKcal = slots.map((sl) => Math.max(50, (target.kcal * share[sl]) / shareSum));
    const WS = 0.35;
    // coordinate descent on grams
    const total = () => {
      const t = { kcal: 0, p: 0, f: 0, c: 0 };
      pick.forEach((ri, i) => {
        t.kcal += (ri.per100.kcal * g[i]) / 100;
        t.p += (ri.per100.p * g[i]) / 100;
        t.f += (ri.per100.f * g[i]) / 100;
        t.c += (ri.per100.c * g[i]) / 100;
      });
      return t;
    };
    for (let it = 0; it < 30; it++) {
      for (let i = 0; i < pick.length; i++) {
        const t = total();
        const a = pick[i].per100;
        // gradient of weighted relative error w.r.t. g_i
        const comp = (val: number, tg: number, coef: number, w: number) => {
          const s = Math.max(tg, 10);
          return { num: (w * coef * (tg - val + coef * g[i])) / (s * s), den: (w * coef * coef) / (s * s) };
        };
        const parts = [comp(t.kcal, target.kcal, a.kcal / 100, W.kcal), comp(t.p, target.p, a.p / 100, W.p), comp(t.f, target.f, a.f / 100, W.f), comp(t.c, target.c, a.c / 100, W.c)];
        // keep each meal close to its share of the day (no 1 kg snacks)
        const ck = a.kcal / 100;
        parts.push({ num: (WS * ck * slotKcal[i]) / (slotKcal[i] * slotKcal[i]), den: (WS * ck * ck) / (slotKcal[i] * slotKcal[i]) });
        const nn = parts.reduce((s, x) => s + x.num, 0);
        const dd = parts.reduce((s, x) => s + x.den, 0);
        if (dd > 0) g[i] = Math.max(lo[i], Math.min(hi[i], nn / dd));
      }
    }
    for (let i = 0; i < g.length; i++) g[i] = Math.round(g[i] / 10) * 10;
    const t = total();
    const e = errFor(t, target);
    const like = pick.reduce((s, ri) => s + likeScore(ri, prefs), 0);
    candidates.push({
      meals: pick.map((ri, i) => ({
        slot: slots[i],
        info: ri,
        grams: g[i],
        macros: { kcal: (ri.per100.kcal * g[i]) / 100, p: (ri.per100.p * g[i]) / 100, f: (ri.per100.f * g[i]) / 100, c: (ri.per100.c * g[i]) / 100 },
      })),
      total: t,
      fit: Math.max(0, 100 * (1 - Math.sqrt(e / 4.6))) + like * 0.8,
    });
  }
  candidates.sort((a, b) => b.fit - a.fit);
  const out: DayPlan[] = [];
  for (const c of candidates) {
    const ids = new Set(c.meals.map((m) => m.info.recipe.id));
    const overlap = out.some((o) => o.meals.filter((m) => ids.has(m.info.recipe.id)).length > Math.floor(slots.length / 2));
    if (!overlap) out.push({ ...c, fit: Math.min(100, c.fit) });
    if (out.length >= variants) break;
  }
  return out;
}
