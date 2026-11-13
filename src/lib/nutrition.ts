import type { Goal, Profile, TrainingPlan } from './types';
import { bmrKatch, KCAL_PER_KG_FAT, type Composition } from './energy';

export interface Targets {
  bmr: number;
  base: number;
  workoutsAvg: number;
  tdee: number;
  dailyDelta: number; // kcal/day relative to tdee (negative = deficit)
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber: number;
  waterMl: number;
  weeklyKg: number;
  warnings: string[];
}

export const GOAL_LABEL: Record<Goal, string> = {
  cut: 'Сушка',
  recomp: 'Рекомпозиция',
  maintain: 'Поддержание',
  bulk: 'Набор массы',
};

export const GOAL_DEFAULT_RATE: Record<Goal, number> = { cut: -0.6, recomp: -0.15, maintain: 0, bulk: 0.25 };
export const GOAL_DEFAULT_PROTEIN: Record<Goal, number> = { cut: 2.4, recomp: 2.4, maintain: 2.0, bulk: 2.0 };

export function planWorkoutsPerDay(plan: TrainingPlan | null, weight: number) {
  if (!plan) return 0;
  const met = plan.prefs.intensity === 'hard' ? 6 : plan.prefs.intensity === 'light' ? 3.5 : 5;
  let total = 0;
  for (const d of plan.schedule) {
    if (d === 'rest') continue;
    const day = plan.days.find((x) => x.id === d);
    if (!day) continue;
    const strengthMin = day.estMinutes - (day.cardio?.minutes ?? 0);
    total += (met - 1) * weight * (strengthMin / 60);
    if (day.cardio) total += (day.cardio.met - 1) * weight * (day.cardio.minutes / 60);
  }
  return total / 7;
}

export function computeTargets(profile: Profile, comp: Composition, plan: TrainingPlan | null, avgWatch?: number): Targets {
  const bmr = bmrKatch(comp.ffm);
  let base: number;
  if (profile.activityMode === 'watch') base = bmr * 1.1 + (avgWatch ?? 350);
  else if (profile.activityMode === 'steps') base = bmr * 1.15 + 250;
  else base = bmr * profile.activityFactor;
  const workoutsAvg = profile.activityMode === 'watch' ? 0 : planWorkoutsPerDay(plan, comp.weight);
  const tdee = base + workoutsAvg;
  const weeklyKg = (comp.weight * profile.weeklyRatePct) / 100;
  let dailyDelta = (weeklyKg * KCAL_PER_KG_FAT) / 7;
  const warnings: string[] = [];
  if (dailyDelta < -tdee * 0.3) {
    dailyDelta = -tdee * 0.3;
    warnings.push('Дефицит ограничен 30% от расхода — сильнее худеть небезопасно для мышц.');
  }
  let kcal = tdee + dailyDelta;
  const floor = profile.sex === 'male' ? 1500 : 1200;
  if (kcal < Math.max(floor, bmr * 0.95)) {
    kcal = Math.max(floor, bmr * 0.95);
    warnings.push('Калорийность не опускается ниже базового обмена — организм начнёт экономить энергию.');
  }
  if (profile.weeklyRatePct < -1) warnings.push('Темп больше 1% веса в неделю повышает потерю мышц.');
  const p = Math.round((profile.proteinPerKgFfm * comp.ffm) / 5) * 5;
  let f = Math.round(profile.fatPerKgBw * comp.weight);
  f = Math.max(f, Math.round((kcal * 0.2) / 9));
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  if (kcal - p * 4 - f * 9 < 0) warnings.push('Белок и жиры не помещаются в калорийность — уменьшите жиры.');
  return {
    bmr,
    base,
    workoutsAvg,
    tdee,
    dailyDelta: kcal - tdee,
    kcal: Math.round(kcal),
    p,
    f,
    c,
    fiber: Math.round((14 * kcal) / 1000),
    waterMl: Math.round((comp.weight * 33) / 50) * 50,
    weeklyKg: ((kcal - tdee) * 7) / KCAL_PER_KG_FAT,
    warnings,
  };
}
