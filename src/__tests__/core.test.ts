import { describe, expect, it } from 'vitest';
import { liveState, KCAL_PER_KG_FAT, monthSummaries, dailyBalances, navyBodyFat, calibrations } from '../lib/energy';
import { parseQr, completeFields, parseDateLoose } from '../lib/qr';
import { buildBody } from '../body/model';
import { measureBody } from '../body/measure';
import { DEFAULT_PROFILE } from '../lib/defaults';
import { generatePlan, exById } from '../lib/training';
import type { TrainingPrefs } from '../lib/types';
import type { FoodEntry, Measurement } from '../lib/types';

const m0: Measurement = { id: 'a', date: new Date(2026, 9, 1, 8, 0).toISOString(), source: 'manual', weight: 80, fatPct: 20, fatKg: 16, ffm: 64, smm: 36 };
const entry = (day: Date, kcal: number): FoodEntry => ({ id: String(Math.random()), time: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 13).toISOString(), meal: 'lunch', name: 'x', grams: 100, per100: { kcal, p: 0, f: 0, c: 0 } });

describe('strict 7700 ledger', () => {
  it('7700 kcal deficit equals exactly −1 kg fat', () => {
    const profile = { ...DEFAULT_PROFILE, activityFactor: 1.35 };
    const food: Record<string, FoodEntry[]> = {};
    const exp = (370 + 21.6 * 64) * 1.35; // daily expenditure
    // 10 full days, each with deficit of 770 kcal
    for (let i = 1; i <= 10; i++) {
      const d = new Date(2026, 9, 1 + i);
      const k = `2026-10-${String(1 + i).padStart(2, '0')}`;
      food[k] = [entry(d, exp - 770)];
    }
    const at = new Date(2026, 9, 11, 23, 59, 59, 999);
    // measurement day: no entries → not counted
    const st = liveState({ profile, measurements: [m0], food, activity: {} }, at)!;
    expect(st.fatDelta).toBeCloseTo(-7700 / KCAL_PER_KG_FAT, 2);
    expect(st.weight).toBeCloseTo(79, 2);
    expect(st.ffm).toBe(64);
  });
  it('days without food entries are not counted', () => {
    const st = liveState({ profile: DEFAULT_PROFILE, measurements: [m0], food: {}, activity: {} }, new Date(2026, 9, 20))!;
    expect(st.fatDelta).toBe(0);
    expect(st.missingDays).toBeGreaterThan(10);
  });
  it('monthly summary converts balance into fat kg', () => {
    const food: Record<string, FoodEntry[]> = { '2026-10-05': [entry(new Date(2026, 9, 5), 2000)] };
    const days = dailyBalances({ profile: DEFAULT_PROFILE, measurements: [m0], food, activity: {} }, '2026-10-01', '2026-10-31');
    const [oct] = monthSummaries(days);
    expect(oct.loggedDays).toBe(1);
    expect(oct.fatKg).toBeCloseTo(oct.balance / 7700, 6);
  });
});

describe('QR parser', () => {
  it('parses key=value', () => {
    const p = parseQr('weight=82.4;pbf=19.5;smm=37.2;vfl=8;date=2026-11-10 08:15');
    expect(p.fields.weight).toBe(82.4);
    expect(p.fields.fatPct).toBe(19.5);
    expect(p.fields.smm).toBe(37.2);
    expect(p.fields.visceral).toBe(8);
    expect(new Date(p.date!).getDate()).toBe(10);
    const c = completeFields(p.fields)!;
    expect(c.fatKg).toBeCloseTo(16.07, 1);
  });
  it('parses JSON and URL params', () => {
    expect(parseQr('{"Weight":"75,0","BFM":"12.5"}').fields).toMatchObject({ weight: 75, fatKg: 12.5 });
    const u = parseQr('https://example.com/r?wt=90&pbf=25&smm=38');
    expect(u.kind).toBe('url');
    expect(u.fields).toMatchObject({ weight: 90, fatPct: 25, smm: 38 });
    expect(parseQr('https://cloud.example.com/result/ABC123').linkOnly).toBe(true);
  });
  it('uses learned positional mapping for plain numbers', () => {
    const raw = '20261110;81.2;18.4;36.9';
    const first = parseQr(raw);
    expect(first.kind).toBe('numbers');
    const learned = { [first.signature]: { weight: 1, fatPct: 2, smm: 3 } };
    expect(parseQr(raw, learned).fields).toMatchObject({ weight: 81.2, fatPct: 18.4, smm: 36.9 });
  });
});

describe('3D body realism', () => {
  const waist = (fatKg: number) => {
    const s = buildBody({ sex: 'male', heightCm: 178, weight: 64 + fatKg, fatKg, ffm: 64, smm: 36 });
    return measureBody(s).find((g) => g.key === 'waist')!.cm;
  };
  it('1 kg of fat barely changes the waist, 10 kg clearly does', () => {
    const w14 = waist(14);
    const d1 = w14 - waist(13);
    const d10 = w14 - waist(4);
    expect(d1).toBeGreaterThan(0.6);
    expect(d1).toBeLessThan(2.2);
    expect(d10).toBeGreaterThan(9);
    expect(d10).toBeLessThan(20);
  });
});

describe('ledger edge cases', () => {
  const profile = { ...DEFAULT_PROFILE, activityFactor: 1.35 };
  const tdee = (370 + 21.6 * 64) * 1.35;
  const at = (y: number, m: number, d: number, hh: number, mm = 0) => new Date(y, m, d, hh, mm);
  const e = (when: Date, kcal: number): FoodEntry => ({ id: String(Math.random()), time: when.toISOString(), meal: 'lunch', name: 'x', grams: 100, per100: { kcal, p: 0, f: 0, c: 0 } });

  it('food eaten before the weigh-in on the same day is not counted', () => {
    const m: Measurement = { ...m0, date: at(2026, 9, 1, 19).toISOString() };
    // logged later in the evening, but eaten in the morning / afternoon
    const food = { '2026-10-01': [e(at(2026, 9, 1, 8, 30), 700), e(at(2026, 9, 1, 13, 30), 1100)] };
    const st = liveState({ profile, measurements: [m], food, activity: {} }, at(2026, 9, 1, 21, 30))!;
    expect(st.balanceSinceAnchor).toBe(0); // nothing eaten after the weigh-in → the remaining hours are not charged either
    const food2 = { '2026-10-01': [...food['2026-10-01'], e(at(2026, 9, 1, 20), 800)] };
    const st2 = liveState({ profile, measurements: [m], food: food2, activity: {} }, at(2026, 9, 1, 21, 30))!;
    expect(st2.days[0].intake).toBe(800);
    expect(st2.balanceSinceAnchor).toBeCloseTo(800 - (tdee * 2.5) / 24, 0);
  });

  it('interior days are taken by diary key, whatever the timestamps say (time-zone change, DST)', () => {
    const food: Record<string, FoodEntry[]> = {};
    for (let d = 2; d <= 6; d++) {
      // timestamps shifted by +9 h (as if logged in another time zone): some fall on the next calendar day
      food[`2026-10-0${d}`] = [e(at(2026, 9, d, 8 + 9), 800), e(at(2026, 9, d, 21 + 9), 1566)];
    }
    const st = liveState({ profile, measurements: [m0], food, activity: {} }, at(2026, 9, 7, 12))!;
    const interior = st.days.filter((x) => x.key >= '2026-10-02' && x.key <= '2026-10-06');
    expect(interior.every((x) => x.logged && x.intake === 2366)).toBe(true);
  });

  it('a finished day with implausibly little food is not counted unless confirmed', () => {
    const food = { '2026-10-03': [e(at(2026, 9, 3, 9), 300)] };
    const st = liveState({ profile, measurements: [m0], food, activity: {} }, at(2026, 9, 5, 12))!;
    expect(st.days.find((x) => x.key === '2026-10-03')!.suspect).toBe(true);
    expect(st.balanceSinceAnchor).toBe(0);
    const st2 = liveState({ profile, measurements: [m0], food, activity: { '2026-10-03': { complete: true, activities: [] } } }, at(2026, 9, 5, 12))!;
    expect(st2.balanceSinceAnchor).toBeCloseTo(300 - tdee, 0);
  });

  it('weekly weigh-ins still produce a calibration window (>= 14 days)', () => {
    const ms: Measurement[] = [0, 7, 14, 21].map((d, i) => ({ ...m0, id: 'w' + i, date: at(2026, 9, 1 + d, 8).toISOString(), fatKg: 16 - i * 0.3, weight: 80 - i * 0.3 }));
    const food: Record<string, FoodEntry[]> = {};
    for (let d = 1; d <= 22; d++) food[`2026-10-${String(d).padStart(2, '0')}`] = [e(at(2026, 9, d, 13), Math.round(tdee - 500))];
    const cs = calibrations({ profile, measurements: ms, food, activity: {} });
    expect(cs.length).toBe(1);
    // ledger predicts ~ -0.9 kg in 14 days, scale shows -0.6 kg → real expenditure is lower than assumed
    expect(cs[0].biasPerDay).toBeLessThan(0);
  });

  it('rejects impossible and future dates, and impossible tape values', () => {
    expect(parseDateLoose('31.02.2026')).toBeUndefined();
    expect(parseDateLoose('2099-01-01 10:00')).toBeUndefined();
    expect(parseDateLoose('10.11.2026 08:15')).toBeDefined();
    expect(Number.isNaN(navyBodyFat('male', 180, 38, 85))).toBe(true);
    expect(navyBodyFat('male', 180, 90, 39)).toBeGreaterThan(10);
  });
});

describe('training plan generator invariants', () => {
  it('holds for a broad sample of preference combinations', () => {
    const goals = ['cut', 'recomp', 'maintain', 'bulk'] as const;
    const exps = ['novice', 'intermediate', 'advanced'] as const;
    const places = ['gym', 'home_dumbbells', 'home_bodyweight'] as const;
    const ints = ['light', 'moderate', 'hard'] as const;
    const prios: TrainingPrefs['priority'][] = [[], ['shoulders'], ['glutes', 'abs'], ['chest', 'back', 'biceps']];
    const avoids: TrainingPrefs['avoid'][] = [[], ['knees'], ['lower_back'], ['knees', 'lower_back', 'shoulders']];
    let n = 0;
    for (const goal of goals)
      for (const experience of exps)
        for (const daysPerWeek of [2, 3, 4, 5, 6] as const)
          for (const sessionMinutes of [30, 45, 60, 75, 90] as const)
            for (const place of places)
              for (const intensity of ints)
                for (const priority of prios)
                  for (const avoid of avoids) {
                    if (n++ % 7) continue; // sample every 7th of 34 560 combinations
                    const prefs: TrainingPrefs = { goal, experience, daysPerWeek, sessionMinutes, place, intensity, priority, avoid, cardio: 'none' };
                    const p = generatePlan(prefs);
                    const tag = JSON.stringify(prefs);
                    expect(p.days.length, tag).toBe(daysPerWeek);
                    expect(p.schedule.filter((x) => x !== 'rest').length, tag).toBe(daysPerWeek);
                    const maxLevel = experience === 'novice' ? 1 : experience === 'intermediate' ? 2 : 3;
                    for (const d of p.days) {
                      const ids = d.exercises.map((x) => x.exerciseId);
                      expect(new Set(ids).size, tag).toBe(ids.length);
                      expect(ids.length, tag).toBeGreaterThanOrEqual(2);
                      expect(d.estMinutes, tag).toBeLessThanOrEqual(sessionMinutes + 10);
                      for (const pe of d.exercises) {
                        const ex = exById(pe.exerciseId)!;
                        expect(ex.stress.some((s) => avoid.includes(s)), tag).toBe(false);
                        expect(ex.level, tag).toBeLessThanOrEqual(maxLevel);
                        expect(pe.sets, tag).toBeGreaterThanOrEqual(2);
                        expect(pe.sets, tag).toBeLessThanOrEqual(5);
                      }
                    }
                    for (const v of Object.values(p.weeklySets)) expect(v!, tag).toBeLessThanOrEqual(26);
                  }
  });
});
