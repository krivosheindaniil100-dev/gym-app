// Deterministic 60-day demo state for UI tests (zustand persist format under key "CapacitorStorage.bodytwin-v1").
function makeSeed(now = new Date()) {
  const days = 60;
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const food = {};
  const activity = {};
  const foods = [
    ['Овсянка на молоке', { kcal: 102, p: 3.6, f: 2.4, c: 16 }],
    ['Куриная грудка запечённая', { kcal: 155, p: 30.5, f: 3.5, c: 0.5 }],
    ['Гречка варёная', { kcal: 112, p: 4.5, f: 1.2, c: 20.4 }],
    ['Творог 5%', { kcal: 121, p: 17.2, f: 5, c: 1.8 }],
    ['Банан', { kcal: 95, p: 1.5, f: 0.2, c: 21.8 }],
    ['Рис белый варёный', { kcal: 128, p: 2.7, f: 0.4, c: 28.5 }],
    ['Яйцо куриное (С1)', { kcal: 157, p: 12.7, f: 11.5, c: 0.7 }],
    ['Салат из овощей', { kcal: 60, p: 1.5, f: 4, c: 5 }],
  ];
  const meals = ['breakfast', 'lunch', 'snack', 'dinner'];
  for (let i = days; i >= 1; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (rnd() < 0.08) continue; // a forgotten day
    const k = key(d);
    const list = [];
    const target = 2150 + (rnd() - 0.5) * 500;
    let kc = 0;
    let j = 0;
    while (kc < target) {
      const [name, per100] = foods[Math.floor(rnd() * foods.length)];
      const grams = Math.round((80 + rnd() * 200) / 10) * 10;
      const t = new Date(d);
      t.setHours(Math.min(22, 8 + j * 3), 10, 0);
      list.push({ id: k + '_' + j, time: t.toISOString(), meal: meals[Math.min(3, j)], name, grams, per100 });
      kc += (per100.kcal * grams) / 100;
      j++;
    }
    food[k] = list;
    if (i % 2 === 0) {
      const t = new Date(d);
      t.setHours(19, 0, 0);
      activity[k] = { activities: [{ id: 'a' + k, time: t.toISOString(), name: 'Тренировка: Верх A', minutes: 65, kcal: 380, source: 'workout' }] };
    }
  }
  const mk = (daysAgo, w, pct, smm) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(8, 30, 0, 0);
    const fk = (w * pct) / 100;
    return { id: 'm' + daysAgo, date: d.toISOString(), source: 'qr', weight: w, fatPct: pct, fatKg: +fk.toFixed(2), ffm: +(w - fk).toFixed(2), smm, visceral: 9 };
  };
  return {
    state: {
      onboarded: true,
      profile: {
        name: 'Даниил',
        sex: 'male',
        birthYear: 1997,
        heightCm: 182,
        goal: 'cut',
        weeklyRatePct: -0.6,
        activityMode: 'lifestyle',
        activityFactor: 1.35,
        proteinPerKgFfm: 2.4,
        fatPerKgBw: 0.8,
        calibrate: false,
        targetFatPct: 14,
        food: { diet: 'omnivore', exclude: [], likes: ['poultry', 'dairy'], sweetTooth: true, maxCookMinutes: 60, mealsPerDay: 4 },
        training: { goal: 'cut', experience: 'intermediate', daysPerWeek: 4, sessionMinutes: 60, place: 'gym', intensity: 'moderate', priority: ['shoulders'], avoid: [], cardio: 'after' },
      },
      measurements: [mk(60, 92.0, 25.5, 38.4), mk(31, 89.6, 23.9, 38.3), mk(4, 87.7, 22.6, 38.2)],
      food,
      activity,
      customFoods: [],
      recentFoods: [],
      plan: null,
      sessions: [],
      activeSession: null,
      qrLearned: {},
    },
    version: 0,
  };
}

module.exports = { makeSeed, STORAGE_KEY: 'CapacitorStorage.bodytwin-v1' };
