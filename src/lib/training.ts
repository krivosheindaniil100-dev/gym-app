/**
 * Individual training plan generator.
 * Split by days/week → day templates of movement slots → exercises filtered by equipment, injuries, level;
 * sets/reps/RIR/rest by goal, experience and intensity; time budget per session; weekly volume control.
 */
import { EXERCISES } from '../data/exercises';
import { CARDIO_FOR_PLAN } from './met';
import { uid } from './date';
import type { Equipment, Exercise, MovementPattern, MuscleGroup, PlannedDay, PlannedExercise, TrainingPlan, TrainingPrefs } from './types';

export const EX_MAP = new Map(EXERCISES.map((e) => [e.id, e]));
export const exById = (id: string) => EX_MAP.get(id);

export const MUSCLE_LABEL: Record<MuscleGroup, string> = {
  chest: 'Грудь',
  back: 'Спина (широчайшие)',
  traps: 'Трапеции',
  shoulders: 'Дельты (перед/средние)',
  rear_delts: 'Задние дельты',
  biceps: 'Бицепс',
  triceps: 'Трицепс',
  forearms: 'Предплечья',
  abs: 'Пресс',
  obliques: 'Косые мышцы',
  lower_back: 'Поясница',
  glutes: 'Ягодицы',
  quads: 'Квадрицепс',
  hamstrings: 'Бицепс бедра',
  adductors: 'Приводящие',
  calves: 'Икры',
};

const PLACE_EQUIP: Record<TrainingPrefs['place'], Equipment[]> = {
  gym: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'pullup_bar', 'bench', 'kettlebell', 'band'],
  home_dumbbells: ['dumbbell', 'bodyweight', 'bench', 'pullup_bar', 'band', 'kettlebell'],
  home_bodyweight: ['bodyweight', 'pullup_bar', 'band'],
};

type Slot = { pattern?: MovementPattern; target?: MuscleGroup; compound?: boolean; key: string };

const S = (pattern: MovementPattern, key: string): Slot => ({ pattern, key, compound: true });
const I = (target: MuscleGroup, key: string): Slot => ({ target, key, compound: false });

const DAY_TEMPLATES: Record<string, { name: string; focus: string; slots: Slot[] }> = {
  fbA: {
    name: 'Всё тело A',
    focus: 'Присед, жим, тяга сверху',
    slots: [S('squat', 'sq'), S('horizontal_push', 'hp'), S('vertical_pull', 'vpl'), S('hinge', 'hg'), I('shoulders', 'sd'), I('biceps', 'bi'), { pattern: 'core', key: 'core' }],
  },
  fbB: {
    name: 'Всё тело B',
    focus: 'Тяга бедром, жим вверх, тяга к поясу',
    slots: [S('hinge', 'hg'), S('vertical_push', 'vp'), S('horizontal_pull', 'hpl'), S('lunge', 'lg'), I('rear_delts', 'rd'), I('triceps', 'tri'), { pattern: 'core', key: 'core' }],
  },
  fbC: {
    name: 'Всё тело C',
    focus: 'Выпады, жим под углом, подтягивания',
    slots: [S('lunge', 'lg'), S('horizontal_push', 'hp2'), S('vertical_pull', 'vpl2'), I('glutes', 'gl'), I('shoulders', 'sd'), I('calves', 'cf'), I('abs', 'abs')],
  },
  upA: {
    name: 'Верх A',
    focus: 'Грудь, спина, плечи, руки',
    slots: [S('horizontal_push', 'hp'), S('horizontal_pull', 'hpl'), S('vertical_push', 'vp'), S('vertical_pull', 'vpl'), I('shoulders', 'sd'), I('biceps', 'bi'), I('triceps', 'tri')],
  },
  upB: {
    name: 'Верх B',
    focus: 'Спина, грудь под углом, дельты',
    slots: [S('vertical_pull', 'vpl2'), S('horizontal_push', 'hp2'), S('horizontal_pull', 'hpl2'), I('rear_delts', 'rd'), I('shoulders', 'sd2'), I('triceps', 'tri2'), I('biceps', 'bi2')],
  },
  loA: {
    name: 'Низ A',
    focus: 'Квадрицепс, ягодицы, икры',
    slots: [S('squat', 'sq'), S('hinge', 'hg'), S('lunge', 'lg'), I('hamstrings', 'hm'), I('calves', 'cf'), { pattern: 'core', key: 'core' }],
  },
  loB: {
    name: 'Низ B',
    focus: 'Тяга бедром, ягодицы, задняя поверхность',
    slots: [S('hinge', 'hg2'), S('squat', 'sq2'), I('glutes', 'gl'), I('hamstrings', 'hm2'), I('calves', 'cf2'), I('abs', 'abs')],
  },
  push: {
    name: 'Жим',
    focus: 'Грудь, плечи, трицепс',
    slots: [S('horizontal_push', 'hp'), S('vertical_push', 'vp'), S('horizontal_push', 'hp2'), I('shoulders', 'sd'), I('triceps', 'tri'), I('triceps', 'tri2')],
  },
  pull: {
    name: 'Тяга',
    focus: 'Спина, задние дельты, бицепс',
    slots: [S('vertical_pull', 'vpl'), S('horizontal_pull', 'hpl'), S('vertical_pull', 'vpl2'), I('rear_delts', 'rd'), I('biceps', 'bi'), I('biceps', 'bi2')],
  },
  legs: {
    name: 'Ноги',
    focus: 'Квадрицепс, ягодицы, бицепс бедра',
    slots: [S('squat', 'sq'), S('hinge', 'hg'), S('lunge', 'lg'), I('hamstrings', 'hm'), I('calves', 'cf'), I('abs', 'abs')],
  },
};

function splitFor(p: TrainingPrefs): { name: string; days: string[]; why: string } {
  switch (p.daysPerWeek) {
    case 2:
      return { name: 'Фулбоди ×2', days: ['fbA', 'fbB'], why: 'При 2 тренировках каждая мышца должна работать в каждой из них — так частота ×2 в неделю.' };
    case 3:
      return p.experience === 'novice'
        ? { name: 'Фулбоди ×3', days: ['fbA', 'fbB', 'fbC'], why: 'Новичку лучше всего подходит фулбоди 3 раза: частая практика техники и быстрый прогресс.' }
        : { name: 'Верх / Низ / Фулбоди', days: ['upA', 'loA', 'fbC'], why: 'Три дня с разными акцентами дают частоту ×2 на каждую мышцу при умеренном объёме за сессию.' };
    case 4:
      return { name: 'Верх / Низ ×2', days: ['upA', 'loA', 'upB', 'loB'], why: 'Сплит верх/низ — золотой стандарт для 4 дней: каждая мышца 2 раза в неделю, хорошее восстановление.' };
    case 5:
      return { name: 'Верх / Низ + Жим / Тяга / Ноги', days: ['upA', 'loA', 'push', 'pull', 'legs'], why: 'Гибрид для 5 дней: 2 раза в неделю на каждую группу с повышенным объёмом.' };
    default:
      return { name: 'Жим / Тяга / Ноги ×2', days: ['push', 'pull', 'legs', 'push', 'pull', 'legs'], why: 'PPL ×2 — максимальный объём для опытных при 6 днях в неделю.' };
  }
}

const SCHEDULES: Record<number, number[]> = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
};

function prescription(p: TrainingPrefs, compound: boolean, ex: Exercise): Omit<PlannedExercise, 'exerciseId'> {
  const lvl = p.experience;
  let sets = compound ? 3 : 3;
  let repMin = 8,
    repMax = 12,
    rest = compound ? 120 : 75,
    rir = 2;
  switch (p.goal) {
    case 'cut':
      // keep heavy loads to preserve muscle; moderate volume
      if (compound) {
        repMin = 6;
        repMax = 10;
        rest = 120;
      } else {
        repMin = 10;
        repMax = 15;
        rest = 60;
      }
      break;
    case 'recomp':
      if (compound) {
        repMin = 6;
        repMax = 10;
      } else {
        repMin = 10;
        repMax = 15;
      }
      break;
    case 'bulk':
      if (compound) {
        sets = 4;
        repMin = 6;
        repMax = 10;
        rest = 120;
      } else {
        repMin = 8;
        repMax = 15;
      }
      break;
    case 'maintain':
      repMin = 8;
      repMax = 12;
      break;
  }
  if (lvl === 'novice') {
    rir = 3;
    sets = Math.min(sets, 3);
    if (compound) {
      repMin = Math.max(repMin, 8);
      repMax = Math.max(repMax, 12);
    }
  } else if (lvl === 'advanced') {
    rir = 1;
    if (compound && p.goal !== 'cut') sets += 1;
  }
  if (p.intensity === 'light') {
    sets = Math.max(2, sets - 1);
    rir += 1;
  } else if (p.intensity === 'hard') {
    sets += compound ? 1 : 0;
    rir = Math.max(0, rir - 1);
  }
  if (ex.timed) {
    repMin = 30;
    repMax = 60;
    rest = 45;
  }
  if (ex.pattern === 'core' && !ex.timed) {
    repMin = 10;
    repMax = 20;
    rest = 45;
  }
  return { sets, repMin, repMax, rir, restSec: rest };
}

function exerciseMinutes(pe: Omit<PlannedExercise, 'exerciseId'>, ex: Exercise) {
  const work = ex.timed ? (pe.repMax + pe.repMin) / 2 : ((pe.repMin + pe.repMax) / 2) * 3.5;
  const perSet = work * (ex.unilateral ? 2 : 1) + pe.restSec;
  return (pe.sets * perSet) / 60 + 1; // + setup
}

const maxSetsFor = (ex: Exercise) => (ex.compound ? 5 : 4);
const strengthMinutes = (exs: PlannedExercise[]) => exs.reduce((s, pe) => s + exerciseMinutes(pe, EX_MAP.get(pe.exerciseId)!), 0);

/** Make a day fit the chosen session length: clamp sets, then trim sets → rests → accessory exercises; fill spare time. */
function fitToBudget(exs: PlannedExercise[], budget: number) {
  for (const pe of exs) pe.sets = Math.min(pe.sets, maxSetsFor(EX_MAP.get(pe.exerciseId)!));
  for (let guard = 0; guard < 80 && strengthMinutes(exs) > budget + 2; guard++) {
    const maxSets = Math.max(...exs.map((pe) => pe.sets));
    if (maxSets > 2) {
      // take a set from the last exercise that has the most sets (accessories lose volume before the main lifts)
      for (let i = exs.length - 1; i >= 0; i--)
        if (exs[i].sets === maxSets) {
          exs[i].sets--;
          break;
        }
      continue;
    }
    const floor = (pe: PlannedExercise) => (EX_MAP.get(pe.exerciseId)!.compound ? 75 : 45);
    if (exs.some((pe) => pe.restSec > floor(pe))) {
      for (const pe of exs) pe.restSec = Math.max(floor(pe), pe.restSec - 15);
      continue;
    }
    if (exs.length > 2) {
      exs.pop();
      continue;
    }
    break;
  }
  // use spare time: one more set on the main lifts first
  for (let round = 0; round < 2 && strengthMinutes(exs) < budget * 0.8; round++) {
    for (const pe of exs) {
      const ex = EX_MAP.get(pe.exerciseId)!;
      if (pe.sets >= maxSetsFor(ex)) continue;
      pe.sets++;
      if (strengthMinutes(exs) > budget + 2) {
        pe.sets--;
        break;
      }
    }
  }
}

function weeklyVolume(days: PlannedDay[]): Partial<Record<MuscleGroup, number>> {
  const w: Partial<Record<MuscleGroup, number>> = {};
  for (const d of days)
    for (const pe of d.exercises) {
      const ex = EX_MAP.get(pe.exerciseId)!;
      for (const m of ex.primary) w[m] = (w[m] ?? 0) + pe.sets;
      for (const m of ex.secondary) w[m] = (w[m] ?? 0) + pe.sets * 0.5;
    }
  return w;
}

/** No muscle should get more than ~24 hard sets a week (beyond that recovery suffers, especially in a deficit). */
function capWeeklyVolume(days: PlannedDay[], cap = 24) {
  for (let guard = 0; guard < 120; guard++) {
    const w = weeklyVolume(days);
    const over = (Object.entries(w) as [MuscleGroup, number][]).filter(([, v]) => v > cap).sort((a, b) => b[1] - a[1])[0];
    if (!over) break;
    const m = over[0];
    let best: PlannedExercise | null = null;
    let bestScore = -1;
    for (const d of days)
      for (const pe of d.exercises) {
        const ex = EX_MAP.get(pe.exerciseId)!;
        if (pe.sets <= 2 || !(ex.primary.includes(m) || ex.secondary.includes(m))) continue;
        const score = pe.sets + (ex.compound ? 0 : 0.5) + (ex.primary.includes(m) ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = pe;
        }
      }
    if (!best) break;
    best.sets--;
  }
}

export function availableExercises(p: TrainingPrefs): Exercise[] {
  const eq = new Set(PLACE_EQUIP[p.place]);
  const maxLevel = p.experience === 'novice' ? 1 : p.experience === 'intermediate' ? 2 : 3;
  return EXERCISES.filter((e) => e.equipment.every((x) => eq.has(x)) && !e.stress.some((s) => p.avoid.includes(s)) && e.level <= maxLevel);
}

function candidatesFor(slot: Slot, pool: Exercise[]): Exercise[] {
  if (slot.pattern) {
    let c = pool.filter((e) => e.pattern === slot.pattern);
    if (slot.compound) {
      const comp = c.filter((e) => e.compound);
      if (comp.length) c = comp;
    }
    return c;
  }
  const t = slot.target!;
  let c = pool.filter((e) => e.primary.includes(t) && (e.pattern === 'isolation_upper' || e.pattern === 'isolation_lower' || (t === 'abs' && e.pattern === 'core')));
  if (!c.length) c = pool.filter((e) => e.primary.includes(t));
  return c;
}

/** Rank: prefer barbell/machine in gym for compounds, lower level for novices, stable variety by key. */
function rank(ex: Exercise, p: TrainingPrefs, variant: number, used: Set<string>, usedWeek: Map<string, number>) {
  let s = 0;
  if (used.has(ex.id)) s -= 100;
  s -= (usedWeek.get(ex.id) ?? 0) * 6;
  if (p.experience === 'novice') s -= (ex.level - 1) * 3;
  if (ex.compound) s += 2;
  if (p.place === 'gym' && ex.equipment.some((q) => q === 'barbell' || q === 'machine' || q === 'cable')) s += 1.5;
  if (p.priority.some((m) => ex.primary.includes(m))) s += 2;
  // the hinge slot is the only guaranteed hamstring work in short programmes → prefer RDL-type hinges
  if (ex.pattern === 'hinge' && ex.primary.includes('hamstrings')) s += 1.5;
  if (p.place === 'home_dumbbells' && ex.equipment.includes('dumbbell')) s += 1.5;
  if (p.place !== 'home_bodyweight' && ex.equipment.length === 1 && ex.equipment[0] === 'band') s -= 1;
  // deterministic pseudo-variety
  let h = variant * 31;
  for (let i = 0; i < ex.id.length; i++) h = (h * 33 + ex.id.charCodeAt(i)) % 1000;
  s += (h / 1000) * 1.2;
  return s;
}

export function generatePlan(p: TrainingPrefs): TrainingPlan {
  const split = splitFor(p);
  const pool = availableExercises(p);
  const usedWeek = new Map<string, number>();
  const days: PlannedDay[] = [];
  const warmup = 5;
  // cardio is done after the strength part and is NOT included in the chosen session length
  const cardioMin = p.cardio === 'after' ? (p.goal === 'cut' ? 20 : 12) : 0;
  const budget = p.sessionMinutes - warmup;

  split.days.forEach((tplKey, di) => {
    const tpl = DAY_TEMPLATES[tplKey];
    const used = new Set<string>();
    const exs: PlannedExercise[] = [];
    let minutes = 0;
    // priority muscles get an extra isolation slot on days that train them
    const slots = [...tpl.slots];
    for (const m of p.priority) {
      const relevant = tpl.slots.some((s) => {
        if (s.target === m) return true;
        const pat = s.pattern;
        if (!pat) return false;
        return pool.some((e) => e.pattern === pat && e.primary.includes(m));
      });
      if (relevant && !slots.some((s) => s.target === m && s.key.endsWith('+'))) slots.splice(Math.min(slots.length, 4), 0, I(m, `${m}+`));
    }
    for (const slot of slots) {
      const cands = candidatesFor(slot, pool);
      if (!cands.length) continue;
      const best = [...cands].sort((a, b) => rank(b, p, di + (slot.key.endsWith('2') ? 7 : 0), used, usedWeek) - rank(a, p, di + (slot.key.endsWith('2') ? 7 : 0), used, usedWeek))[0];
      if (used.has(best.id)) continue;
      const pres = prescription(p, !!slot.compound && best.compound, best);
      if (p.priority.some((m) => best.primary.includes(m))) pres.sets += 1;
      const mins = exerciseMinutes(pres, best);
      if (minutes + mins > budget && exs.length >= 3) {
        // try trimming a set to fit
        if (pres.sets > 2 && minutes + mins * ((pres.sets - 1) / pres.sets) <= budget) pres.sets -= 1;
        else continue;
      }
      minutes += exerciseMinutes(pres, best);
      used.add(best.id);
      usedWeek.set(best.id, (usedWeek.get(best.id) ?? 0) + 1);
      exs.push({ exerciseId: best.id, ...pres, note: best.cue });
    }
    fitToBudget(exs, budget);
    const day: PlannedDay = {
      id: uid(),
      name: tpl.name,
      focus: tpl.focus,
      exercises: exs,
      estMinutes: Math.round(strengthMinutes(exs) + warmup + cardioMin),
    };
    if (cardioMin) {
      const c = p.place === 'gym' ? CARDIO_FOR_PLAN.liss : { name: 'Быстрая ходьба / ходьба по лестнице', met: 5.0 };
      day.cardio = { name: c.name, minutes: cardioMin, met: c.met, note: 'Пульс 60–70% от максимума, можно разговаривать.' };
    }
    days.push(day);
  });

  capWeeklyVolume(days);
  for (const d of days) d.estMinutes = Math.round(strengthMinutes(d.exercises) + warmup + (d.cardio?.minutes ?? 0));

  // schedule (Mon..Sun)
  const sched: (string | 'rest')[] = new Array(7).fill('rest');
  SCHEDULES[p.daysPerWeek].forEach((wd, i) => (sched[wd] = days[i].id));

  const weeklySets = weeklyVolume(days);

  const rationale = [split.why];
  const tips: string[] = [];
  if (p.goal === 'cut') {
    rationale.push('На сушке главное — сохранить мышцы: оставляем тяжёлые базовые упражнения (6–10 повторов), объём умеренный, чтобы восстанавливаться в дефиците.');
    tips.push('Не гонитесь за «жиросжигающими» многоповторками — жир уходит за счёт дефицита калорий, а тяжёлые веса сигнализируют телу сохранять мышцы.');
    tips.push('8–10 тысяч шагов в день дают +250–400 ккал расхода без вреда для восстановления.');
    tips.push('Если рабочие веса начали падать 2 недели подряд — дефицит слишком большой.');
  }
  if (p.goal === 'bulk') rationale.push('На наборе объём выше: больше подходов в базовых, рабочие веса растут каждую неделю.');
  if (p.goal === 'recomp') rationale.push('Рекомпозиция работает при небольшом дефиците, высоком белке и прогрессии нагрузок.');
  if (p.avoid.length) rationale.push('Исключены упражнения, нагружающие: ' + p.avoid.map((a) => ({ knees: 'колени', lower_back: 'поясницу', shoulders: 'плечи', elbows: 'локти', wrists: 'запястья' })[a]).join(', ') + '.');
  if (p.priority.length) rationale.push('Приоритет: ' + p.priority.map((m) => MUSCLE_LABEL[m]).join(', ') + ' — +1 подход и дополнительное упражнение.');
  tips.push('Двойная прогрессия: когда во всех подходах сделали верхнюю границу повторов — добавьте 2,5 кг (или 1–2 кг на гантели).');
  tips.push(`RIR — сколько повторов «в запасе» до отказа. Оставляйте указанный запас, отказ только в последнем подходе изоляции.`);
  tips.push('Разминка 5–7 минут + 1–2 лёгких подхода в первом упражнении.');

  return {
    id: uid(),
    createdAt: new Date().toISOString(),
    prefs: { ...p },
    splitName: split.name,
    rationale,
    days,
    schedule: sched,
    weeklySets,
    tips,
  };
}

export function alternatives(exId: string, p: TrainingPrefs): Exercise[] {
  const ex = EX_MAP.get(exId);
  if (!ex) return [];
  const pool = availableExercises(p);
  return pool
    .filter((e) => e.id !== exId && (e.pattern === ex.pattern || e.primary.some((m) => ex.primary.includes(m))))
    .sort((a, b) => Number(b.pattern === ex.pattern) - Number(a.pattern === ex.pattern) || b.primary.filter((m) => ex.primary.includes(m)).length - a.primary.filter((m) => ex.primary.includes(m)).length)
    .slice(0, 8);
}

export function sessionKcal(minutes: number, intensity: 'light' | 'moderate' | 'hard', weight: number) {
  const met = intensity === 'hard' ? 6 : intensity === 'light' ? 3.5 : 5;
  return Math.max(0, (met - 1) * weight * (minutes / 60));
}

