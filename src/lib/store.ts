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

const prefStorage: StateStorage = {
  getItem: async (name) => (await Preferences.get({ key: name })).value,
  setItem: async (name, value) => {
    await Preferences.set({ key: name, value });
  },
  removeItem: async (name) => {
    await Preferences.remove({ key: name });
  },
};

export { DEFAULT_PROFILE };

export interface AppState {
  hydrated: boolean;
  onboarded: boolean;
  profile: Profile;
  measurements: Measurement[];
  food: Record<string, FoodEntry[]>;
  activity: Record<string, DayActivity>;
  customFoods: Food[];
  recentFoods: { id: string; name: string; brand?: string; per100: Food['per100']; units?: Food['units']; lastGrams: number; source: Food['source'] }[];
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
  saveCustomFood: (f: Food) => void;
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
        set({ measurements: [...get().measurements, full].sort((a, b) => a.date.localeCompare(b.date)) });
        return full;
      },
      updateMeasurement: (id, m) =>
        set({ measurements: get().measurements.map((x) => (x.id === id ? { ...x, ...m } : x)).sort((a, b) => a.date.localeCompare(b.date)) }),
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
          recentFoods: [{ id: f.id, name: f.name, brand: f.brand, per100: f.per100, units: f.units, lastGrams: grams, source: f.source }, ...rest].slice(0, 40),
        });
      },
      saveCustomFood: (f) => {
        const rest = get().customFoods.filter((x) => x.id !== f.id && (!f.barcode || x.barcode !== f.barcode));
        set({ customFoods: [f, ...rest] });
      },
      deleteCustomFood: (id) => set({ customFoods: get().customFoods.filter((x) => x.id !== id) }),
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
          measurements: data.measurements ?? [],
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
