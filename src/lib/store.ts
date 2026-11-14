import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { Preferences } from '@capacitor/preferences';
import type {
  ActivityEntry,
  DayActivity,
  Food,
  FoodEntry,
  Measurement,
  Profile,
  TrainingPlan,
  WorkoutSession,
} from './types';
import { dayKey, uid } from './date';
import type { MField } from './qr';
import { DEFAULT_PROFILE } from './defaults';

// Writes are debounced: the whole state is one JSON blob, and typing in a field would otherwise rewrite it per keystroke.
let pendingWrite: { name: string; value: string } | null = null;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
export function flushStorage(): Promise<void> {
  clearTimeout(writeTimer);
  const p = pendingWrite;
  pendingWrite = null;
  return p ? Preferences.set({ key: p.name, value: p.value }).catch((e) => console.error('persist failed', e)) : Promise.resolve();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => document.hidden && flushStorage());
  window.addEventListener('pagehide', () => void flushStorage());
}

const prefStorage: StateStorage = {
  getItem: async (name) => (await Preferences.get({ key: name })).value,
  setItem: async (name, value) => {
    pendingWrite = { name, value };
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flushStorage, 250);
  },
  removeItem: async (name) => {
    pendingWrite = null;
    clearTimeout(writeTimer);
    await Preferences.remove({ key: name });
  },
};

export { DEFAULT_PROFILE };

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** Drop corrupted measurements (NaN persisted as null, impossible values) and future dates. */
export function saneMeasurements(ms: Measurement[] | undefined): Measurement[] {
  return (ms ?? [])
    .filter((m) => m && finite(m.weight) && finite(m.fatKg) && finite(m.ffm) && finite(m.fatPct) && m.weight > 20 && m.ffm > 10 && m.fatKg >= 0 && !Number.isNaN(new Date(m.date).getTime()))
    .map((m) => (new Date(m.date).getTime() > Date.now() + 5 * 60000 ? { ...m, date: new Date().toISOString() } : m))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface AppState {
  hydrated: boolean;
  onboarded: boolean;
  profile: Profile;
  measurements: Measurement[];
  food: Record<string, FoodEntry[]>;
  activity: Record<string, DayActivity>;
  customFoods: Food[];
  recentFoods: { id: string; name: string; brand?: string; per100: Food['per100']; units?: Food['units']; lastGrams: number; source: Food['source']; barcode?: string; imageUrl?: string }[];
  plan: TrainingPlan | null;
  sessions: WorkoutSession[];
  activeSession: WorkoutSession | null;
  qrLearned: Record<string, Partial<Record<MField, number>>>;

  setOnboarded: (v: boolean) => void;
  setProfile: (p: Partial<Profile>) => void;
  addMeasurement: (m: Omit<Measurement, 'id'>) => Measurement;
  updateMeasurement: (id: string, m: Partial<Measurement>) => void;
  deleteMeasurement: (id: string) => void;
  addFood: (day: string, e: Omit<FoodEntry, 'id'>) => void;
  updateFood: (day: string, id: string, e: Partial<FoodEntry>) => void;
  deleteFood: (day: string, id: string) => void;
  rememberFood: (f: Food, grams: number) => void;
  /** @param replacesId id of the product this one corrects (e.g. an Open Food Facts entry) – recents are re-pointed */
  saveCustomFood: (f: Food, replacesId?: string) => void;
  deleteCustomFood: (id: string) => void;
  setDayActivity: (day: string, a: Partial<DayActivity>) => void;
  addActivity: (day: string, a: Omit<ActivityEntry, 'id'>) => void;
  deleteActivity: (day: string, id: string) => void;
  setPlan: (p: TrainingPlan | null) => void;
  startSession: (s: WorkoutSession) => void;
  updateSession: (s: WorkoutSession) => void;
  finishSession: (s: WorkoutSession) => void;
  cancelSession: () => void;
  deleteSession: (id: string) => void;
  learnQr: (signature: string, mapping: Partial<Record<MField, number>>) => void;
  importAll: (data: Partial<AppState>) => void;
  resetAll: () => void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      onboarded: false,
      profile: DEFAULT_PROFILE,
      measurements: [],
      food: {},
      activity: {},
      customFoods: [],
      recentFoods: [],
      plan: null,
      sessions: [],
      activeSession: null,
      qrLearned: {},

      setOnboarded: (v) => set({ onboarded: v }),
      setProfile: (p) => set({ profile: { ...get().profile, ...p } }),
      addMeasurement: (m) => {
        const full = { ...m, id: uid() };
        set({ measurements: saneMeasurements([...get().measurements, full]) });
        return full;
      },
      updateMeasurement: (id, m) =>
        set({ measurements: saneMeasurements(get().measurements.map((x) => (x.id === id ? { ...x, ...m } : x))) }),
      deleteMeasurement: (id) => set({ measurements: get().measurements.filter((x) => x.id !== id) }),
      addFood: (day, e) => {
        const list = get().food[day] ?? [];
        set({ food: { ...get().food, [day]: [...list, { ...e, id: uid() }] } });
      },
      updateFood: (day, id, e) => {
        const list = get().food[day] ?? [];
        set({ food: { ...get().food, [day]: list.map((x) => (x.id === id ? { ...x, ...e } : x)) } });
      },
      deleteFood: (day, id) => {
        const list = (get().food[day] ?? []).filter((x) => x.id !== id);
        const food = { ...get().food };
        if (list.length) food[day] = list;
        else delete food[day];
        set({ food });
      },
      rememberFood: (f, grams) => {
        const rest = get().recentFoods.filter((r) => r.id !== f.id);
        set({
          recentFoods: [
            { id: f.id, name: f.name, brand: f.brand, per100: f.per100, units: f.units, lastGrams: grams, source: f.source, barcode: f.barcode, imageUrl: f.imageUrl },
            ...rest,
          ].slice(0, 40),
        });
      },
      saveCustomFood: (f, replacesId) => {
        const nb = (c?: string) => (c ? c.replace(/\D/g, '').replace(/^0+/, '') : '');
        const same = (x: { id: string; barcode?: string }) => x.id === f.id || x.id === replacesId || (!!f.barcode && nb(x.barcode) === nb(f.barcode));
        const rest = get().customFoods.filter((x) => !same(x));
        // keep "recent" rows in sync with the corrected values
        const recents = get().recentFoods.map((r) => (same(r) ? { ...r, id: f.id, name: f.name, brand: f.brand, per100: f.per100, units: f.units, source: f.source, barcode: f.barcode ?? r.barcode, imageUrl: f.imageUrl ?? r.imageUrl } : r));
        const seen = new Set<string>();
        set({ customFoods: [f, ...rest], recentFoods: recents.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))) });
      },
      deleteCustomFood: (id) => set({ customFoods: get().customFoods.filter((x) => x.id !== id), recentFoods: get().recentFoods.filter((x) => x.id !== id) }),
      setDayActivity: (day, a) => {
        const cur = get().activity[day] ?? { activities: [] };
        set({ activity: { ...get().activity, [day]: { ...cur, ...a } } });
      },
      addActivity: (day, a) => {
        const cur = get().activity[day] ?? { activities: [] };
        set({ activity: { ...get().activity, [day]: { ...cur, activities: [...cur.activities, { ...a, id: uid() }] } } });
      },
      deleteActivity: (day, id) => {
        const cur = get().activity[day];
        if (!cur) return;
        set({ activity: { ...get().activity, [day]: { ...cur, activities: cur.activities.filter((x) => x.id !== id) } } });
      },
      setPlan: (p) => set({ plan: p }),
      startSession: (s) => set({ activeSession: s }),
      updateSession: (s) => set({ activeSession: s }),
      finishSession: (s) => {
        const day = dayKey(s.date);
        const finished = { ...s, finished: true };
        const cur = get().activity[day] ?? { activities: [] };
        const acts = cur.activities.filter((a) => a.sessionId !== s.id);
        acts.push({
          id: uid(),
          time: s.date,
          name: `Тренировка: ${s.dayName}`,
          minutes: s.minutes,
          kcal: s.kcal,
          source: 'workout',
          sessionId: s.id,
        });
        set({
          sessions: [...get().sessions.filter((x) => x.id !== s.id), finished].sort((a, b) => a.date.localeCompare(b.date)),
          activeSession: null,
          activity: { ...get().activity, [day]: { ...cur, activities: acts } },
        });
      },
      cancelSession: () => set({ activeSession: null }),
      deleteSession: (id) => {
        const s = get().sessions.find((x) => x.id === id);
        const activity = { ...get().activity };
        if (s) {
          const day = dayKey(s.date);
          const cur = activity[day];
          if (cur) activity[day] = { ...cur, activities: cur.activities.filter((a) => a.sessionId !== id) };
        }
        set({ sessions: get().sessions.filter((x) => x.id !== id), activity });
      },
      learnQr: (signature, mapping) => set({ qrLearned: { ...get().qrLearned, [signature]: mapping } }),
      importAll: (data) =>
        set({
          onboarded: data.onboarded ?? true,
          profile: { ...DEFAULT_PROFILE, ...(data.profile ?? {}) },
          measurements: saneMeasurements(data.measurements),
          food: data.food ?? {},
          activity: data.activity ?? {},
          customFoods: data.customFoods ?? [],
          recentFoods: data.recentFoods ?? [],
          plan: data.plan ?? null,
          sessions: data.sessions ?? [],
          activeSession: null,
          qrLearned: data.qrLearned ?? {},
        }),
      resetAll: () =>
        set({
          onboarded: false,
          profile: DEFAULT_PROFILE,
          measurements: [],
          food: {},
          activity: {},
          customFoods: [],
          recentFoods: [],
          plan: null,
          sessions: [],
          activeSession: null,
          qrLearned: {},
        }),
    }),
    {
      name: 'bodytwin-v1',
      storage: createJSONStorage(() => prefStorage),
      partialize: (s) => {
        const { hydrated: _h, ...rest } = s;
        return Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== 'function')) as Partial<AppState>;
      },
      onRehydrateStorage: () => () => {
        useApp.setState({ hydrated: true });
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...p,
          measurements: saneMeasurements(p.measurements),
          profile: { ...DEFAULT_PROFILE, ...(p.profile ?? {}), food: { ...DEFAULT_PROFILE.food, ...(p.profile?.food ?? {}) }, training: { ...DEFAULT_PROFILE.training, ...(p.profile?.training ?? {}) } },
        };
      },
    },
  ),
);

export function exportData(): string {
  const s = useApp.getState();
  const data = {
    app: 'BodyTwin',
    version: 1,
    exportedAt: new Date().toISOString(),
    onboarded: s.onboarded,
    profile: s.profile,
    measurements: s.measurements,
    food: s.food,
    activity: s.activity,
    customFoods: s.customFoods,
    recentFoods: s.recentFoods,
    plan: s.plan,
    sessions: s.sessions,
    qrLearned: s.qrLearned,
  };
  return JSON.stringify(data);
}
