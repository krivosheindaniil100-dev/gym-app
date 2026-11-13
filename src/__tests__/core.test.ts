import { describe, expect, it } from 'vitest';
import { liveState, KCAL_PER_KG_FAT, monthSummaries, dailyBalances } from '../lib/energy';
import { parseQr, completeFields } from '../lib/qr';
import { buildBody } from '../body/model';
import { measureBody } from '../body/measure';
import { DEFAULT_PROFILE } from '../lib/defaults';
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
    const food: Record<string, FoodEntry[]> = { '2026-10-05': [entry(new Date(2026, 9, 5), 500)] };
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
