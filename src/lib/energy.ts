/**
 * Energy balance ledger.
 *
 * STRICT RULE (user's choice): 7700 kcal of cumulative deficit = −1 kg of fat (adipose tissue),
 * 7700 kcal of cumulative surplus = +1 kg of fat. Lean mass changes only through real measurements.
 *
 * Anchor = latest scale measurement (truth). Between measurements the live state is
 * anchor + Σ(intake − expenditure)/7700, counted from the exact measurement time.
 * Days without any food entries are NOT counted (otherwise a forgotten log looks like starvation).
 */
import type { ActivityMode, DayActivity, FoodEntry, Measurement, Profile } from './types';
import { addDays, dayFraction, dayKey, fromKey } from './date';

export const KCAL_PER_KG_FAT = 7700;

export interface Composition {
  weight: number;
  fatKg: number;
  ffm: number;
  smm: number;
  fatPct: number;
}

export function compFromMeasurement(m: Measurement): Composition {
  return {
    weight: m.weight,
    fatKg: m.fatKg,
    ffm: m.ffm,
    smm: m.smm ?? m.ffm * 0.56,
    fatPct: m.fatPct,
  };
}

export function bmrKatch(ffm: number) {
  return 370 + 21.6 * ffm;
}

export function bmrMifflin(sex: 'male' | 'female', weight: number, heightCm: number, age: number) {
  return 10 * weight + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
}

export function age(profile: Profile) {
  return new Date().getFullYear() - profile.birthYear;
}

/** Net kcal of walking N steps (above resting): ~0.5 kcal per kg per km. */
export function stepsKcal(steps: number, weight: number, heightCm: number) {
  const km = (steps * heightCm * 0.415) / 100000;
  return 0.5 * weight * km;
}

/** Net kcal of an activity by MET: (MET − 1) × kg × hours (resting part is already in BMR). */
export function metKcal(met: number, weight: number, minutes: number) {
  return Math.max(0, (met - 1) * weight * (minutes / 60));
}

export interface DayExpenditure {
  bmr: number;
  base: number; // BMR × factor (incl. TEF & everyday NEAT)
  steps: number;
  activities: number;
  watch: number;
  total: number;
  mode: ActivityMode;
}

/**
 * @param fraction    share of the day's clock time that is counted (BMR / lifestyle part)
 * @param cumFraction share of the day's cumulative user-entered values (steps, watch kcal) that is counted;
 *                    today's values are "so far" numbers, so they are NOT scaled by the elapsed time.
 */
export function dayExpenditure(profile: Profile, comp: Composition, act: DayActivity | undefined, fraction = 1, cumFraction = fraction): DayExpenditure {
  const bmr = bmrKatch(comp.ffm);
  let mode = profile.activityMode;
  if (mode === 'watch' && !(act?.watchActiveKcal && act.watchActiveKcal > 0)) mode = 'lifestyle';
  if (mode === 'steps' && !(act?.steps && act.steps > 0)) mode = 'lifestyle';
  const acts = act?.activities ?? [];
  if (mode === 'watch') {
    const base = bmr * 1.1 * fraction;
    const watch = (act!.watchActiveKcal ?? 0) * cumFraction;
    return { bmr, base, steps: 0, activities: 0, watch, total: base + watch, mode };
  }
  if (mode === 'steps') {
    const base = bmr * 1.15 * fraction;
    const st = stepsKcal(act!.steps ?? 0, comp.weight, profile.heightCm) * cumFraction;
    // walking / running sessions are already inside the step count
    const actKcal = acts.filter((a) => !a.stepBased).reduce((s, a) => s + a.kcal, 0);
    return { bmr, base, steps: st, activities: actKcal, watch: 0, total: base + st + actKcal, mode };
  }
  const actKcal = acts.reduce((s, a) => s + a.kcal, 0);
  const base = bmr * profile.activityFactor * fraction;
  return { bmr, base, steps: 0, activities: actKcal, watch: 0, total: base + actKcal, mode: 'lifestyle' };
}

export interface Macros {
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber: number;
}

export function entryMacros(e: FoodEntry): Macros {
  const k = e.grams / 100;
  return { kcal: e.per100.kcal * k, p: e.per100.p * k, f: e.per100.f * k, c: e.per100.c * k, fiber: (e.per100.fiber ?? 0) * k };
}

export function sumMacros(entries: FoodEntry[]): Macros {
  const t: Macros = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
  for (const e of entries) {
    const m = entryMacros(e);
    t.kcal += m.kcal;
    t.p += m.p;
    t.f += m.f;
    t.c += m.c;
    t.fiber += m.fiber;
  }
  return t;
}

export interface LedgerDay {
  key: string;
  intake: number;
  expenditure: number;
  balance: number;
  logged: boolean;
  partial: boolean;
  fatDelta: number; // kg (balance / 7700)
  /** counted share of the day (1 = full day) */
  frac: number;
  /** past day with implausibly little food logged – not counted until the user confirms it */
  suspect?: boolean;
}

/** A finished day with less than this share of BMR logged is treated as "forgot to log" unless confirmed. */
export const SUSPECT_BMR_SHARE = 0.45;

export function isSuspectDay(intakeKcal: number, bmr: number, act: DayActivity | undefined): boolean {
  if (act?.complete === true) return false;
  if (act?.complete === false) return true;
  return intakeKcal < bmr * SUSPECT_BMR_SHARE;
}

export interface LedgerInput {
  profile: Profile;
  measurements: Measurement[];
  food: Record<string, FoodEntry[]>;
  activity: Record<string, DayActivity>;
}

export interface LiveState extends Composition {
  anchor: Measurement;
  /** kg of fat change since anchor */
  fatDelta: number;
  balanceSinceAnchor: number;
  days: LedgerDay[];
  missingDays: number;
  calibratedBias: number;
}

export function sortedMeasurements(ms: Measurement[]) {
  return [...ms].sort((a, b) => a.date.localeCompare(b.date));
}

export function anchorAt(ms: Measurement[], at: Date): Measurement | null {
  let best: Measurement | null = null;
  for (const m of ms) {
    if (new Date(m.date).getTime() <= at.getTime() && (!best || m.date > best.date)) best = m;
  }
  return best;
}

/** Composition at moment `at` (default: now) according to the strict 7700 ledger. */
export function liveState(input: LedgerInput, at: Date = new Date(), bias = 0): LiveState | null {
  const anchor = anchorAt(input.measurements, at);
  if (!anchor) return null;
  const comp = compFromMeasurement(anchor);
  const aDate = new Date(anchor.date);
  const startKey = dayKey(aDate);
  const endKey = dayKey(at);
  const days: LedgerDay[] = [];
  let balance = 0;
  let missing = 0;
  const aMs = aDate.getTime();
  const atMs = at.getTime();
  const bmr = bmrKatch(comp.ffm);
  for (let k = startKey; k <= endKey; k = addDays(k, 1)) {
    const all = input.food[k] ?? [];
    const isStart = k === startKey;
    const isEnd = k === endKey;
    const f0 = isStart ? dayFraction(aDate) : 0;
    const f1 = isEnd ? dayFraction(at) : 1;
    const frac = Math.max(0, f1 - f0);
    // Day membership comes from the diary key (robust to time-zone changes and DST); the timestamps only cut
    // the ledger at its two ends: nothing eaten before the weigh-in, nothing after the evaluated moment.
    const inLedger = (iso: string) => {
      const t = new Date(iso).getTime();
      return (!isStart || t >= aMs) && (!isEnd || t <= atMs);
    };
    const entries = isStart || isEnd ? all.filter((e) => inLedger(e.time)) : all;
    const act = input.activity[k];
    const actFiltered: DayActivity | undefined = act && (isStart || isEnd) ? { ...act, activities: act.activities.filter((a) => inLedger(a.time)) } : act;
    const intake = sumMacros(entries).kcal;
    // cumulative day values (steps / watch kcal): today's are "so far"; on the weigh-in day only the part after it counts
    const cumFrac = isEnd ? (isStart && f1 > 0 ? frac / f1 : 1) : isStart ? 1 - f0 : 1;
    const exp = dayExpenditure(input.profile, comp, actFiltered, frac, cumFrac).total + bias * frac;
    let logged = entries.length > 0;
    const suspect = logged && !isStart && !isEnd && isSuspectDay(intake, bmr, act);
    if (suspect) logged = false;
    const bal = logged ? intake - exp : 0;
    if (!logged && !isEnd && !isStart) missing++;
    balance += bal;
    days.push({ key: k, intake, expenditure: exp, balance: bal, logged, partial: frac < 0.999, fatDelta: bal / KCAL_PER_KG_FAT, frac, suspect });
  }
  const fatDelta = balance / KCAL_PER_KG_FAT;
  const fatKg = Math.max(1.5, comp.fatKg + fatDelta);
  const weight = comp.weight + (fatKg - comp.fatKg);
  return {
    weight,
    fatKg,
    ffm: comp.ffm,
    smm: comp.smm,
    fatPct: (fatKg / weight) * 100,
    anchor,
    fatDelta: fatKg - comp.fatKg,
    balanceSinceAnchor: balance,
    days,
    missingDays: missing,
    calibratedBias: bias,
  };
}

/** Full-day balances for a range of day keys (independent of anchors; uses composition valid that day). */
export function dailyBalances(input: LedgerInput, fromKeyStr: string, toKeyStr: string, bias = 0): LedgerDay[] {
  const out: LedgerDay[] = [];
  const today = dayKey();
  for (let k = fromKeyStr; k <= toKeyStr; k = addDays(k, 1)) {
    const entries = input.food[k] ?? [];
    const anchor = anchorAt(input.measurements, new Date(fromKey(k).getTime() + 86399000)) ?? sortedMeasurements(input.measurements)[0];
    if (!anchor) break;
    const comp = compFromMeasurement(anchor);
    const isToday = k === today;
    const frac = isToday ? dayFraction() : 1;
    const intake = sumMacros(entries).kcal;
    const exp = dayExpenditure(input.profile, comp, input.activity[k], frac, 1).total + bias * frac;
    let logged = entries.length > 0;
    const suspect = logged && !isToday && isSuspectDay(intake, bmrKatch(comp.ffm), input.activity[k]);
    if (suspect) logged = false;
    const bal = logged ? intake - exp : 0;
    out.push({ key: k, intake, expenditure: exp, balance: bal, logged, partial: isToday, fatDelta: bal / KCAL_PER_KG_FAT, frac, suspect });
  }
  return out;
}

export interface MonthSummary {
  month: string; // YYYY-MM
  loggedDays: number;
  totalDays: number;
  balance: number;
  fatKg: number;
}

export function monthSummaries(days: LedgerDay[]): MonthSummary[] {
  const map = new Map<string, MonthSummary>();
  for (const d of days) {
    const m = d.key.slice(0, 7);
    let s = map.get(m);
    if (!s) {
      s = { month: m, loggedDays: 0, totalDays: 0, balance: 0, fatKg: 0 };
      map.set(m, s);
    }
    s.totalDays++;
    if (d.logged) {
      s.loggedDays++;
      s.balance += d.balance;
    }
  }
  for (const s of map.values()) s.fatKg = s.balance / KCAL_PER_KG_FAT;
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Average daily balance over the last N fully logged days (excluding today). */
export function recentAvgBalance(input: LedgerInput, n = 14, bias = 0): { avg: number; days: number } | null {
  const today = dayKey();
  const from = addDays(today, -n);
  const days = dailyBalances(input, from, addDays(today, -1), bias).filter((d) => d.logged);
  if (days.length < 3) return null;
  return { avg: days.reduce((s, d) => s + d.balance, 0) / days.length, days: days.length };
}

export interface Calibration {
  from: Measurement;
  to: Measurement;
  days: number;
  coverage: number;
  predictedFat: number;
  actualFat: number;
  /** kcal/day: positive → real expenditure is higher than the model assumes */
  biasPerDay: number;
}

/**
 * Compare the ledger prediction with real measurements. Windows span ≥ 14 days: from a measurement to the first
 * later one that is at least two weeks away (so weekly weigh-ins still calibrate).
 */
export function calibrations(input: LedgerInput): Calibration[] {
  const ms = sortedMeasurements(input.measurements);
  const out: Calibration[] = [];
  let i = 0;
  while (i < ms.length - 1) {
    const a = ms[i];
    let j = i + 1;
    while (j < ms.length && (new Date(ms[j].date).getTime() - new Date(a.date).getTime()) / 86400000 < 14) j++;
    if (j >= ms.length) break;
    const b = ms[j];
    i = j;
    const days = (new Date(b.date).getTime() - new Date(a.date).getTime()) / 86400000;
    const st = liveState({ ...input, measurements: [a] }, new Date(b.date));
    if (!st) continue;
    const loggedDays = st.days.filter((d) => d.logged);
    const countedDays = loggedDays.reduce((s, d) => s + d.frac, 0);
    const coverage = countedDays / Math.max(1e-6, st.days.reduce((s, d) => s + d.frac, 0));
    if (coverage < 0.7 || countedDays < 7) continue;
    const predicted = st.fatKg - a.fatKg;
    const actual = b.fatKg - a.fatKg;
    out.push({ from: a, to: b, days, coverage, predictedFat: predicted, actualFat: actual, biasPerDay: ((predicted - actual) * KCAL_PER_KG_FAT) / countedDays });
  }
  return out;
}

/**
 * Evidence-weighted bias from the latest calibration windows, clamped to ±500 kcal/day.
 * Bio-impedance fat readings are noisy (±1–1.5 kg), so the correction is shrunk until ~6 weeks of logged data exist.
 */
export function calibrationBias(input: LedgerInput): number {
  const cs = calibrations(input).slice(-3);
  if (!cs.length) return 0;
  let w = 0,
    s = 0;
  for (const c of cs) {
    const ww = c.days * c.coverage;
    w += ww;
    s += c.biasPerDay * ww;
  }
  const shrink = Math.min(1, w / 42);
  return Math.max(-500, Math.min(500, (s / w) * shrink));
}

export function forecast(comp: Composition, avgBalance: number, days: number): Composition {
  const fatKg = Math.max(1.5, comp.fatKg + (avgBalance * days) / KCAL_PER_KG_FAT);
  const weight = comp.weight + (fatKg - comp.fatKg);
  return { ...comp, fatKg, weight, fatPct: (fatKg / weight) * 100 };
}

/** US Navy body-fat estimate (cm). */
export function navyBodyFat(sex: 'male' | 'female', heightCm: number, waistCm: number, neckCm: number, hipCm?: number): number {
  const inch = (x: number) => x / 2.54;
  // the logarithm needs waist (+ hips) clearly larger than the neck; otherwise the inputs are wrong
  if ((sex === 'male' ? waistCm : waistCm + (hipCm ?? waistCm * 1.35)) - neckCm <= 1) return NaN;
  if (sex === 'male') {
    return 86.01 * Math.log10(inch(waistCm) - inch(neckCm)) - 70.041 * Math.log10(inch(heightCm)) + 36.76;
  }
  return 163.205 * Math.log10(inch(waistCm) + inch(hipCm ?? waistCm * 1.35) - inch(neckCm)) - 97.684 * Math.log10(inch(heightCm)) - 78.387;
}

/** Deurenberg BMI-based estimate (fallback when nothing else is known). */
export function deurenbergBodyFat(sex: 'male' | 'female', weight: number, heightCm: number, ageY: number) {
  const bmi = weight / (heightCm / 100) ** 2;
  return 1.2 * bmi + 0.23 * ageY - 10.8 * (sex === 'male' ? 1 : 0) - 5.4;
}

export function ffmi(ffm: number, heightCm: number) {
  const h = heightCm / 100;
  return ffm / (h * h) + 6.1 * (1.8 - h);
}

export function bmi(weight: number, heightCm: number) {
  return weight / (heightCm / 100) ** 2;
}

export function fatCategory(sex: 'male' | 'female', pct: number): { label: string; tone: 'good' | 'ok' | 'warn' | 'bad' } {
  const t = sex === 'male' ? [6, 10, 14, 18, 25] : [14, 18, 22, 26, 32];
  if (pct < t[0]) return { label: 'соревновательная форма', tone: 'warn' };
  if (pct < t[1]) return { label: 'атлетичный, рельеф', tone: 'good' };
  if (pct < t[2]) return { label: 'спортивный', tone: 'good' };
  if (pct < t[3]) return { label: 'подтянутый', tone: 'ok' };
  if (pct < t[4]) return { label: 'средний', tone: 'ok' };
  return { label: 'выше нормы', tone: 'bad' };
}
