import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChefHat, Clock, Flame, Footprints, Plus, RefreshCw, Trash2, Watch } from 'lucide-react';
import { useApp } from '../lib/store';
import { useLive, useNow, useTargets, useBias, useLedgerInput } from '../lib/hooks';
import { dailyBalances, dayExpenditure, entryMacros, metKcal, stepsKcal, sumMacros } from '../lib/energy';
import { addDays, dayKey, fmtDay, fmtWeekday } from '../lib/date';
import { ACTIVITIES } from '../lib/met';
import { GOAL_DEFAULT_PROTEIN, GOAL_DEFAULT_RATE, GOAL_LABEL } from '../lib/nutrition';
import { foodById, planDay, slotsForMeals, suggestDishes, type DayPlan, type Suggestion } from '../lib/mealPlanner';
import { Chips, MacroBar, NumField, Ring, Seg, Sheet, fmt, signed, toast } from '../ui/kit';
import { AddFoodSheet, entryTime, entryToPickable, MEAL_LABEL, MEALS, mealByTime, PortionSheet } from './FoodSheets';
import { AlertTriangle } from 'lucide-react';
import { success } from '../lib/native';
import type { FoodEntry, Goal, MealSlot } from '../lib/types';
import type { RecipeInfo } from '../lib/mealPlanner';

export default function NutritionScreen({ active }: { active: boolean }) {
  const now = useNow(60000);
  const [sub, setSub] = useState<'diary' | 'norm' | 'cook'>('diary');
  const [day, setDay] = useState(dayKey());
  const live = useLive(now);
  const targets = useTargets(live);
  // follow the calendar: if the diary was showing "today" and midnight passed, move to the new day
  const today = dayKey(now);
  const lastToday = useRef(today);
  useEffect(() => {
    if (today !== lastToday.current) {
      if (day === lastToday.current) setDay(today);
      lastToday.current = today;
    }
  }, [today]);

  return (
    <div className={`screen ${active ? 'screen-enter' : ''}`}>
      <div className="topbar">
        <div>
          <h1>Питание</h1>
          <div className="sub">{targets ? `Норма ${fmt(targets.kcal)} ккал · ${GOAL_LABEL[useApp.getState().profile.goal].toLowerCase()}` : ''}</div>
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Seg
          value={sub}
          options={[
            { v: 'diary', l: 'Дневник' },
            { v: 'norm', l: 'Расчёт нормы' },
            { v: 'cook', l: 'Что приготовить' },
          ]}
          onChange={setSub}
        />
      </div>
      {sub === 'diary' && <Diary day={day} setDay={setDay} now={now} />}
      {sub === 'norm' && <Norm />}
      {sub === 'cook' && <Cook day={today} />}
    </div>
  );
}

/* ───────────────────────── Diary ───────────────────────── */

function Diary({ day, setDay, now }: { day: string; setDay: (d: string) => void; now: Date }) {
  const entries = useApp((s) => s.food[day]) ?? [];
  const act = useApp((s) => s.activity[day]);
  const profile = useApp((s) => s.profile);
  const updateFood = useApp((s) => s.updateFood);
  const deleteFood = useApp((s) => s.deleteFood);
  const input = useLedgerInput();
  const bias = useBias();
  const live = useLive(now);
  const targets = useTargets(live);
  const [addMeal, setAddMeal] = useState<MealSlot | null>(null);
  const [edit, setEdit] = useState<FoodEntry | null>(null);
  const [actOpen, setActOpen] = useState(false);
  const setDayActivity = useApp((s) => s.setDayActivity);
  // entries eaten before the weigh-in of that day are not part of the ledger
  const anchorMs = live && dayKey(live.anchor.date) === day ? new Date(live.anchor.date).getTime() : null;

  const total = sumMacros(entries);
  const today = dayKey(now);
  const isToday = day === today;
  const bal = useMemo(() => dailyBalances(input, day, day, bias)[0], [input, day, bias, now.getTime()]);
  const fullExp = live ? dayExpenditure(profile, live, act, 1).total + bias : 0;
  const t = targets;

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <button className="icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="Предыдущий день">
          <ChevronLeft size={20} />
        </button>
        <button className="col" style={{ alignItems: 'center' }} onClick={() => setDay(today)}>
          <span className="bold" style={{ fontSize: 16 }}>
            {isToday ? 'Сегодня' : day === addDays(today, -1) ? 'Вчера' : fmtDay(day)}
          </span>
          <span className="tiny muted">
            {fmtWeekday(day)}, {fmtDay(day, true)}
          </span>
        </button>
        <button className="icon-btn" onClick={() => setDay(addDays(day, 1))} disabled={day >= today} aria-label="Следующий день" style={{ opacity: day >= today ? 0.35 : 1 }}>
          <ChevronRight size={20} />
        </button>
      </div>

      {t && (
        <div className="card glow">
          <div className="row" style={{ gap: 18 }}>
            <Ring value={total.kcal} max={t.kcal} size={128} stroke={11}>
              <div className="big">{total.kcal > t.kcal ? '+' + fmt(total.kcal - t.kcal) : fmt(t.kcal - total.kcal)}</div>
              <div className="cap">{total.kcal > t.kcal ? 'сверх нормы' : 'осталось ккал'}</div>
            </Ring>
            <div className="grow">
              <MacroBar label="Белки" value={total.p} target={t.p} color="var(--protein)" />
              <MacroBar label="Жиры" value={total.f} target={t.f} color="var(--fat)" />
              <MacroBar label="Углеводы" value={total.c} target={t.c} color="var(--carbs)" />
            </div>
          </div>
          <div className="divider" />
          <div className="grid3">
            <div className="col">
              <span className="tiny muted bold">Съедено</span>
              <span className="bold num" style={{ fontSize: 18 }}>
                {fmt(total.kcal)}
              </span>
            </div>
            <div className="col">
              <span className="tiny muted bold">{isToday ? 'Потрачено сейчас' : 'Потрачено'}</span>
              <span className="bold num" style={{ fontSize: 18 }}>
                {fmt(bal?.expenditure ?? 0)}
              </span>
            </div>
            <div className="col">
              <span className="tiny muted bold">Баланс</span>
              <span className={`bold num ${bal?.logged ? (bal.balance <= 0 ? 'pos' : 'neg') : ''}`} style={{ fontSize: 18 }}>
                {bal?.logged ? signed(bal.balance) : '—'}
              </span>
            </div>
          </div>
          {isToday && bal?.logged && (
            <div className="small muted" style={{ marginTop: 8 }}>
              К концу дня расход ≈ {fmt(fullExp)} ккал → итог {signed(total.kcal - fullExp)} ккал = {signed(((total.kcal - fullExp) / 7700) * 1000)} г жира
            </div>
          )}
        </div>
      )}

      {!isToday && entries.length > 0 && (bal?.suspect || act?.complete !== undefined) && (
        <div className="note" style={act?.complete ? { background: 'rgba(124,247,200,.06)', borderColor: 'rgba(124,247,200,.25)', color: 'var(--text-2)' } : undefined}>
          <AlertTriangle size={16} />
          <div>
            {bal?.suspect
              ? `Записано всего ${fmt(total.kcal)} ккал — похоже, дневник за этот день заполнен не полностью. День не учитывается в балансе, чтобы не получилось ложного похудения.`
              : act?.complete
                ? 'День отмечен как заполненный полностью и учитывается в балансе.'
                : 'День исключён из баланса.'}
            <div style={{ marginTop: 8 }}>
              {act?.complete ? (
                <button className="btn sm" onClick={() => setDayActivity(day, { complete: undefined })}>
                  Отменить
                </button>
              ) : (
                <button className="btn sm" onClick={() => setDayActivity(day, { complete: true })}>
                  Это всё, что я съел — учитывать
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <button className="card row" style={{ width: '100%', textAlign: 'left' }} onClick={() => setActOpen(true)}>
        <div className="food-img" style={{ background: 'rgba(255,181,71,.12)', color: 'var(--amber)' }}>
          <Flame size={20} />
        </div>
        <div className="grow">
          <div className="bold">Расход и активность</div>
          <div className="small muted">
            {act?.steps ? `${fmt(act.steps)} шагов · ` : ''}
            {act?.watchActiveKcal ? `часы ${fmt(act.watchActiveKcal)} ккал · ` : ''}
            {(act?.activities.length ?? 0) > 0 ? `${act!.activities.length} активн. · ` : ''}
            нажми, чтобы добавить
          </div>
        </div>
        <ChevronRight size={18} className="muted" />
      </button>

      {MEALS.map((m) => {
        const list = entries.filter((e) => e.meal === m);
        const mt = sumMacros(list);
        return (
          <div className="card" key={m}>
            <div className="meal-head">
              <span className="name">{MEAL_LABEL[m]}</span>
              <span className="small muted num">
                {list.length ? `${fmt(mt.kcal)} ккал · Б${fmt(mt.p)} Ж${fmt(mt.f)} У${fmt(mt.c)}` : ''}
              </span>
            </div>
            <div className="list">
              {list.map((e) => {
                const em = entryMacros(e);
                return (
                  <div className="item" key={e.id} onClick={() => setEdit(e)} role="button">
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="title ellipsis">{e.name}</div>
                      <div className="meta">
                        {fmt(e.grams)} г · Б {fmt(em.p, 1)} Ж {fmt(em.f, 1)} У {fmt(em.c, 1)}
                        {anchorMs !== null && new Date(e.time).getTime() < anchorMs && <span className="badge amber" style={{ marginLeft: 6 }}>до замера</span>}
                      </div>
                    </div>
                    <div className="right bold num">{fmt(em.kcal)}</div>
                  </div>
                );
              })}
            </div>
            <button className="add-line" onClick={() => setAddMeal(m)}>
              <Plus size={18} /> Добавить
            </button>
          </div>
        );
      })}

      <AddFoodSheet open={!!addMeal} onClose={() => setAddMeal(null)} day={day} meal={addMeal ?? mealByTime()} />
      <PortionSheet
        open={!!edit}
        item={edit ? entryToPickable(edit) : null}
        day={day}
        initialMeal={edit?.meal ?? 'lunch'}
        initialGrams={edit?.grams}
        initialTime={edit?.time}
        title="Изменить"
        onClose={() => setEdit(null)}
        onSave={(grams, meal, _item, time) => {
          updateFood(day, edit!.id, { grams, meal, time });
          setEdit(null);
        }}
        onDelete={() => {
          deleteFood(day, edit!.id);
          setEdit(null);
        }}
      />
      <ActivitySheet open={actOpen} onClose={() => setActOpen(false)} day={day} />
    </>
  );
}

/* ───────────────────────── Activity / expenditure ───────────────────────── */

function ActivitySheet({ open, onClose, day }: { open: boolean; onClose: () => void; day: string }) {
  const act = useApp((s) => s.activity[day]);
  const profile = useApp((s) => s.profile);
  const setDayActivity = useApp((s) => s.setDayActivity);
  const addActivity = useApp((s) => s.addActivity);
  const deleteActivity = useApp((s) => s.deleteActivity);
  const live = useLive(new Date());
  const [type, setType] = useState(ACTIVITIES[2].id);
  const [mins, setMins] = useState<number | undefined>(30);
  const [manualKcal, setManualKcal] = useState<number | undefined>();
  const w = live?.weight ?? 75;
  const at = ACTIVITIES.find((a) => a.id === type)!;
  const est = mins ? metKcal(at.met, w, mins) : 0;
  const exp = live ? dayExpenditure(profile, live, act, 1) : null;

  return (
    <Sheet open={open} onClose={onClose} title={`Расход · ${fmtDay(day)}`} full>
      {exp && (
        <div className="card glow">
          <div className="kv">
            <span className="k">Базовый обмен (Кэтч–МакАрдл)</span>
            <span className="v">{fmt(exp.bmr)} ккал</span>
          </div>
          <div className="kv">
            <span className="k">{exp.mode === 'lifestyle' ? `Образ жизни ×${profile.activityFactor}` : exp.mode === 'steps' ? 'Обмен ×1,15 (быт + переваривание)' : 'Обмен ×1,1 (переваривание)'}</span>
            <span className="v">{fmt(exp.base)} ккал</span>
          </div>
          {exp.steps > 0 && (
            <div className="kv">
              <span className="k">Шаги</span>
              <span className="v">+{fmt(exp.steps)} ккал</span>
            </div>
          )}
          {exp.watch > 0 && (
            <div className="kv">
              <span className="k">Активные ккал (часы)</span>
              <span className="v">+{fmt(exp.watch)} ккал</span>
            </div>
          )}
          {exp.activities > 0 && (
            <div className="kv">
              <span className="k">Тренировки и активность</span>
              <span className="v">+{fmt(exp.activities)} ккал</span>
            </div>
          )}
          <div className="kv total">
            <span className="k bold">Итого за день</span>
            <span className="v" style={{ fontSize: 18 }}>
              {fmt(exp.total)} ккал
            </span>
          </div>
        </div>
      )}

      <div className="section-label">
        <Footprints size={12} /> Шаги {profile.activityMode !== 'steps' && <span className="badge">режим «Шаги» в настройках</span>}
      </div>
      <NumField value={act?.steps} onChange={(v) => setDayActivity(day, { steps: v })} suffix="шагов" placeholder="например 9500" />
      {act?.steps ? <div className="small muted" style={{ marginTop: 6 }}>≈ {fmt(stepsKcal(act.steps, w, profile.heightCm))} ккал сверх покоя</div> : null}

      <div className="section-label">
        <Watch size={12} /> Активные калории (Samsung Health / часы) {profile.activityMode !== 'watch' && <span className="badge">режим «Часы»</span>}
      </div>
      <NumField value={act?.watchActiveKcal} onChange={(v) => setDayActivity(day, { watchActiveKcal: v })} suffix="ккал" placeholder="из приложения часов" />

      <div className="section-label">Добавить активность</div>
      <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
        {ACTIVITIES.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · MET {a.met}
          </option>
        ))}
      </select>
      <div className="grid2" style={{ marginTop: 10 }}>
        <NumField value={mins} onChange={setMins} suffix="мин" />
        <NumField value={manualKcal} onChange={setManualKcal} suffix="ккал" placeholder={`≈ ${fmt(est)}`} />
      </div>
      <button
        className="btn primary block"
        style={{ marginTop: 10 }}
        disabled={!mins || mins <= 0}
        onClick={() => {
          addActivity(day, { time: entryTime(day), name: at.name, minutes: mins!, met: at.met, kcal: manualKcal ?? est, source: manualKcal ? 'manual' : 'cardio', stepBased: at.steps });
          setManualKcal(undefined);
          success();
          toast('Активность добавлена');
        }}
      >
        <Plus size={18} /> Добавить {fmt(manualKcal ?? est)} ккал
      </button>
      {profile.activityMode === 'steps' && at.steps && <p className="tiny" style={{ color: 'var(--amber)' }}>В режиме «Шаги» ходьба и бег уже посчитаны шагомером — эта активность не прибавится второй раз.</p>}
      {profile.activityMode === 'watch' && <p className="tiny" style={{ color: 'var(--amber)' }}>В режиме «Часы» активность не прибавляется — её уже посчитали часы.</p>}
      <p className="tiny muted">Считаем чистый расход сверх покоя: (MET − 1) × вес × часы — обмен покоя уже учтён в базовом обмене.</p>

      {(act?.activities.length ?? 0) > 0 && (
        <>
          <div className="section-label">За день</div>
          <div className="card">
            <div className="list">
              {act!.activities.map((a) => (
                <div className="item" key={a.id}>
                  <div className="grow">
                    <div className="title">{a.name}</div>
                    <div className="meta">
                      {fmt(a.minutes)} мин{a.source === 'workout' ? ' · из тренировки' : ''}
                    </div>
                  </div>
                  <div className="right bold num">{fmt(a.kcal)} ккал</div>
                  <button className="icon-btn" onClick={() => deleteActivity(day, a.id)} aria-label="Удалить">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ───────────────────────── Norm ───────────────────────── */

function Norm() {
  const now = useNow(60000);
  const profile = useApp((s) => s.profile);
  const setProfile = useApp((s) => s.setProfile);
  const plan = useApp((s) => s.plan);
  const live = useLive(now);
  const t = useTargets(live);
  if (!t || !live) return null;
  const pk = t.p * 4,
    fk = t.f * 9,
    ck = t.c * 4;
  return (
    <>
      <div className="card glow">
        <div className="row between">
          <div>
            <div className="small muted bold">Норма на день</div>
            <div className="bold num" style={{ fontSize: 34, letterSpacing: '-.02em' }}>
              {fmt(t.kcal)} <span style={{ fontSize: 16, color: 'var(--text-2)' }}>ккал</span>
            </div>
          </div>
          <span className={`badge ${t.dailyDelta < 0 ? 'accent' : t.dailyDelta > 0 ? 'amber' : ''}`}>
            {signed(t.dailyDelta)} ккал/день
          </span>
        </div>
        <div style={{ display: 'flex', height: 10, borderRadius: 10, overflow: 'hidden', margin: '14px 0 10px', gap: 2 }}>
          <div style={{ flex: pk, background: 'var(--protein)' }} />
          <div style={{ flex: fk, background: 'var(--fat)' }} />
          <div style={{ flex: ck, background: 'var(--carbs)' }} />
        </div>
        <div className="grid3">
          {[
            ['Белки', t.p, 'var(--protein)', pk],
            ['Жиры', t.f, 'var(--fat)', fk],
            ['Углеводы', t.c, 'var(--carbs)', ck],
          ].map(([l, g, c, k]) => (
            <div key={l as string} className="col">
              <span className="tiny muted bold">{l as string}</span>
              <span className="bold num" style={{ fontSize: 20, color: c as string }}>
                {fmt(g as number)} г
              </span>
              <span className="tiny muted">{fmt(((k as number) / t.kcal) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Как получилось</div>
        <div className="kv">
          <span className="k">Базовый обмен · 370 + 21,6 × {fmt(live.ffm, 1)} кг сухой массы</span>
          <span className="v">{fmt(t.bmr)}</span>
        </div>
        <div className="kv">
          <span className="k">Обычный день {profile.activityMode === 'lifestyle' ? `(×${profile.activityFactor})` : ''}</span>
          <span className="v">{fmt(t.base)}</span>
        </div>
        <div className="kv">
          <span className="k">Тренировки в среднем за день {plan ? '' : '(нет программы)'}</span>
          <span className="v">+{fmt(t.workoutsAvg)}</span>
        </div>
        {Math.abs(t.bias) >= 1 && (
          <div className="kv">
            <span className="k">Автокоррекция по замерам</span>
            <span className="v">{signed(t.bias)}</span>
          </div>
        )}
        <div className="kv total">
          <span className="k bold">Расход (поддержание)</span>
          <span className="v">{fmt(t.tdee)}</span>
        </div>
        <div className="kv">
          <span className="k">
            Цель: {fmt(Math.abs(t.weeklyKg), 2)} кг/нед × 7700 / 7
          </span>
          <span className="v">{signed(t.dailyDelta)}</span>
        </div>
        <div className="kv total">
          <span className="k bold">Норма</span>
          <span className="v" style={{ color: 'var(--accent)' }}>
            {fmt(t.kcal)}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          Белок {profile.proteinPerKgFfm} г/кг сухой массы · жиры {profile.fatPerKgBw} г/кг веса (не меньше 20% калорий) · углеводы — остаток. Клетчатка ≥ {t.fiber} г, вода ≈ {fmt(t.waterMl / 1000, 1)} л.
        </div>
      </div>
      {t.warnings.map((w) => (
        <div className="note" key={w}>
          {w}
        </div>
      ))}

      <div className="card">
        <div className="card-title">Цель и темп</div>
        <Chips
          value={profile.goal}
          options={(Object.keys(GOAL_LABEL) as Goal[]).map((g) => ({ v: g, l: GOAL_LABEL[g] }))}
          onChange={(g: Goal) => setProfile({ goal: g, weeklyRatePct: GOAL_DEFAULT_RATE[g], proteinPerKgFfm: GOAL_DEFAULT_PROTEIN[g] })}
        />
        <div className="field" style={{ marginTop: 14 }}>
          <label>
            {profile.weeklyRatePct < 0 ? 'Худеть' : profile.weeklyRatePct > 0 ? 'Набирать' : 'Держать вес'}: {fmt(Math.abs(profile.weeklyRatePct), 2)}% веса в неделю ≈ {fmt(Math.abs((live.weight * profile.weeklyRatePct) / 100), 2)} кг
          </label>
          <input type="range" min={-1.2} max={0.75} step={0.05} value={profile.weeklyRatePct} onChange={(e) => setProfile({ weeklyRatePct: Number(e.target.value) })} />
          <div className="timeline-marks">
            <span>−1,2%</span>
            <span>0</span>
            <span>+0,75%</span>
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Белок, г/кг сухой массы</label>
            <NumField value={profile.proteinPerKgFfm} onChange={(v) => v && setProfile({ proteinPerKgFfm: v })} />
          </div>
          <div className="field">
            <label>Жиры, г/кг веса</label>
            <NumField value={profile.fatPerKgBw} onChange={(v) => v && setProfile({ fatPerKgBw: v })} />
          </div>
        </div>
        <p className="tiny muted" style={{ margin: 0 }}>
          Рекомендация для сушки: 0,5–1% веса в неделю, белок 2,2–2,8 г/кг сухой массы — так уходит жир, а не мышцы.
        </p>
      </div>
    </>
  );
}

/* ───────────────────────── Cook ───────────────────────── */

function Cook({ day }: { day: string }) {
  const now = useNow(60000);
  const prefs = useApp((s) => s.profile.food);
  const entries = useApp((s) => s.food[day]) ?? [];
  const addFood = useApp((s) => s.addFood);
  const live = useLive(now);
  const t = useTargets(live);
  const [mode, setMode] = useState<'now' | 'rest' | 'day'>('now');
  const [custom, setCustom] = useState<{ p?: number; f?: number; c?: number } | null>(null);
  const [seed, setSeed] = useState(1);
  const [open, setOpen] = useState<{ info: RecipeInfo; grams: number; slot?: MealSlot; n: number } | null>(null);
  const openN = useRef(0);
  const show = (info: RecipeInfo, grams: number, slot?: MealSlot) => setOpen({ info, grams, slot, n: ++openN.current });
  const tk = t ? `${t.kcal}|${t.p}|${t.f}|${t.c}` : '';
  const ek = entries.map((e) => e.id + e.grams + e.meal).join(',');
  const ck = custom ? `${custom.p}|${custom.f}|${custom.c}` : '';
  const calc = useMemo(() => {
    if (!t) return null;
    const eaten = sumMacros(entries);
    const remaining = { kcal: Math.max(0, t.kcal - eaten.kcal), p: Math.max(0, t.p - eaten.p), f: Math.max(0, t.f - eaten.f), c: Math.max(0, t.c - eaten.c) };
    // meal slots of the day that have nothing logged yet
    const eatenSlots = new Set(entries.map((e) => e.meal));
    let restSlots = slotsForMeals(prefs.mealsPerDay).filter((sl) => !eatenSlots.has(sl));
    if (!restSlots.length && remaining.kcal > 120) restSlots = ['snack'];
    const mealsLeft = Math.max(1, restSlots.length);
    let target = mode === 'day' ? { kcal: t.kcal, p: t.p, f: t.f, c: t.c } : remaining;
    const isCustom = !!custom && !!(custom.p || custom.f || custom.c);
    if (isCustom) {
      const p = custom!.p ?? 0,
        f = custom!.f ?? 0,
        c = custom!.c ?? 0;
      target = { p, f, c, kcal: p * 4 + f * 9 + c * 4 };
    }
    const div = mode === 'now' && !isCustom ? mealsLeft : 1;
    const single = { kcal: target.kcal / div, p: target.p / div, f: target.f / div, c: target.c / div };
    const nothingLeft = mode !== 'day' && !isCustom && remaining.kcal < 60;
    const dishes: Suggestion[] = mode === 'now' && !nothingLeft ? suggestDishes(single, prefs, isCustom ? undefined : restSlots[0], 14) : [];
    const plans: DayPlan[] = mode !== 'now' && !nothingLeft ? planDay(target, prefs, mode === 'day' ? prefs.mealsPerDay : isCustom ? Math.min(mealsLeft, 5) : restSlots, 3, seed * 7919) : [];
    return { single, mealsLeft, dishes, plans, nothingLeft };
  }, [tk, ek, ck, mode, seed, prefs]);
  if (!t || !calc) return null;
  const { single, mealsLeft, dishes, plans, nothingLeft } = calc;

  return (
    <>
      <Seg
        value={mode}
        options={[
          { v: 'now', l: 'Одно блюдо' },
          { v: 'rest', l: 'Остаток дня' },
          { v: 'day', l: 'Целый день' },
        ]}
        onChange={setMode}
      />
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">
          {custom ? 'Свои цели' : mode === 'day' ? 'Норма на день' : mode === 'rest' ? 'Осталось на сегодня' : `На этот приём (из ${mealsLeft})`}
          <button className="link" onClick={() => setCustom(custom ? null : { p: Math.round(single.p), f: Math.round(single.f), c: Math.round(single.c) })}>
            {custom ? 'сбросить' : 'задать БЖУ'}
          </button>
        </div>
        {custom ? (
          <div className="grid3">
            <NumField value={custom.p} onChange={(v) => setCustom({ ...custom, p: v })} suffix="Б" />
            <NumField value={custom.f} onChange={(v) => setCustom({ ...custom, f: v })} suffix="Ж" />
            <NumField value={custom.c} onChange={(v) => setCustom({ ...custom, c: v })} suffix="У" />
          </div>
        ) : (
          <div className="grid3 num">
            <span>
              <b style={{ color: 'var(--protein)' }}>{fmt(single.p)}</b> г белка
            </span>
            <span>
              <b style={{ color: 'var(--fat)' }}>{fmt(single.f)}</b> г жиров
            </span>
            <span>
              <b style={{ color: 'var(--carbs)' }}>{fmt(single.c)}</b> г углев.
            </span>
          </div>
        )}
        <div className="small muted" style={{ marginTop: 8 }}>
          ≈ {fmt(single.kcal)} ккал · {prefs.diet === 'omnivore' ? 'всё' : { no_pork: 'без свинины', pescatarian: 'рыба без мяса', vegetarian: 'вегетарианское' }[prefs.diet]}
          {prefs.exclude.length ? ` · без: ${prefs.exclude.length}` : ''} · до {prefs.maxCookMinutes} мин
        </div>
      </div>

      {nothingLeft && <div className="empty">Норма на сегодня уже выбрана. Посмотри «Целый день», чтобы спланировать завтра.</div>}
      {mode === 'now' && !nothingLeft && dishes.length === 0 && <div className="empty">Нет подходящих блюд — ослабь фильтры в настройках питания.</div>}
      {mode === 'now' &&
        dishes.map((s) => (
          <button key={s.info.recipe.id} className="card" style={{ width: '100%', textAlign: 'left' }} onClick={() => show(s.info, s.grams)}>
            <div className="row between">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bold">{s.info.recipe.name}</div>
                <div className="small muted" style={{ marginTop: 3 }}>
                  <Clock size={12} style={{ verticalAlign: -2 }} /> {s.info.recipe.minutes} мин · порция {fmt(s.grams)} г
                </div>
              </div>
              <span className={`badge ${s.fit > 85 ? 'accent' : s.fit > 65 ? 'violet' : ''}`}>{fmt(s.fit)}%</span>
            </div>
            <div className="row small num" style={{ marginTop: 8, gap: 12 }}>
              <span className="bold">{fmt(s.macros.kcal)} ккал</span>
              <span style={{ color: 'var(--protein)' }}>Б {fmt(s.macros.p)}</span>
              <span style={{ color: 'var(--fat)' }}>Ж {fmt(s.macros.f)}</span>
              <span style={{ color: 'var(--carbs)' }}>У {fmt(s.macros.c)}</span>
            </div>
          </button>
        ))}

      {mode !== 'now' && (
        <>
          {plans.length === 0 && !nothingLeft && <div className="empty">Нет подходящих рецептов — ослабь фильтры в настройках питания.</div>}
          {plans.map((pl, i) => (
            <div className="card" key={i}>
              <div className="card-title">
                Вариант {i + 1}
                <span className="badge accent">{fmt(pl.fit)}% совпадение</span>
              </div>
              {pl.meals.map((m, j) => (
                <div className="item" key={j} onClick={() => show(m.info, m.grams, m.slot)} role="button">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="tiny muted bold">{MEAL_LABEL[m.slot]}</div>
                    <div className="title ellipsis">{m.info.recipe.name}</div>
                    <div className="meta num">
                      {fmt(m.grams)} г · Б {fmt(m.macros.p)} Ж {fmt(m.macros.f)} У {fmt(m.macros.c)}
                    </div>
                  </div>
                  <div className="right bold num">{fmt(m.macros.kcal)}</div>
                </div>
              ))}
              <div className="kv total small">
                <span className="k">Итого</span>
                <span className="v">
                  {fmt(pl.total.kcal)} ккал · Б {fmt(pl.total.p)} Ж {fmt(pl.total.f)} У {fmt(pl.total.c)}
                </span>
              </div>
            </div>
          ))}
          <button className="btn block" onClick={() => setSeed(seed + 1)}>
            <RefreshCw size={18} /> Другие варианты
          </button>
        </>
      )}

      <RecipeSheet
        data={open}
        onClose={() => setOpen(null)}
        onAdd={(info, grams, meal) => {
          addFood(day, { time: entryTime(day, meal), meal, name: info.recipe.name, grams, per100: info.per100, foodId: `recipe_${info.recipe.id}` });
          success();
          toast('Добавлено в дневник');
          setOpen(null);
        }}
      />
    </>
  );
}

function RecipeSheet({ data, onClose, onAdd }: { data: { info: RecipeInfo; grams: number; slot?: MealSlot; n: number } | null; onClose: () => void; onAdd: (info: RecipeInfo, grams: number, meal: MealSlot) => void }) {
  if (!data) return null;
  // remounted for every opening, so grams / meal always start from the suggestion
  return <RecipeBody key={data.n} data={data} onClose={onClose} onAdd={onAdd} />;
}

function RecipeBody({ data, onClose, onAdd }: { data: { info: RecipeInfo; grams: number; slot?: MealSlot }; onClose: () => void; onAdd: (info: RecipeInfo, grams: number, meal: MealSlot) => void }) {
  const [grams, setGrams] = useState<number | undefined>(data.grams);
  const [meal, setMeal] = useState<MealSlot>(data.slot ?? mealByTime());
  const { info } = data;
  const g = grams ?? 0;
  const scale = g / info.total.grams;
  const k = g / 100;
  return (
    <Sheet
      open
      onClose={onClose}
      full
      title={info.recipe.name}
      footer={
        <button className="btn primary block" disabled={!g} onClick={() => onAdd(info, g, meal)}>
          <ChefHat size={18} /> Съел · {fmt(info.per100.kcal * k)} ккал
        </button>
      }
    >
      <div className="chips" style={{ marginBottom: 12 }}>
        <span className="badge">
          <Clock size={12} /> {info.recipe.minutes} мин
        </span>
        {info.recipe.tags.map((t) => (
          <span className="badge" key={t}>
            {t}
          </span>
        ))}
      </div>
      <div className="field">
        <label>Моя порция (готового блюда)</label>
        <NumField value={grams} onChange={setGrams} suffix="г" big max={5000} />
      </div>
      <div className="grid3" style={{ marginBottom: 12, textAlign: 'center' }}>
        <div className="stat">
          <div className="label">Белки</div>
          <div className="value" style={{ color: 'var(--protein)', fontSize: 20 }}>
            {fmt(info.per100.p * k)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Жиры</div>
          <div className="value" style={{ color: 'var(--fat)', fontSize: 20 }}>
            {fmt(info.per100.f * k)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Углеводы</div>
          <div className="value" style={{ color: 'var(--carbs)', fontSize: 20 }}>
            {fmt(info.per100.c * k)}
          </div>
        </div>
      </div>
      <Seg value={meal} options={MEALS.map((x) => ({ v: x, l: MEAL_LABEL[x] }))} onChange={setMeal} />
      <div className="section-label">Продукты на мою порцию</div>
      <div className="card">
        {info.recipe.ingredients.map((ing) => {
          const f = foodName(ing.foodId);
          return (
            <div className="kv" key={ing.foodId}>
              <span className="k">{f}</span>
              <span className="v">{fmt(ing.grams * scale)} г</span>
            </div>
          );
        })}
        <div className="tiny muted" style={{ marginTop: 6 }}>
          Весь рецепт: {fmt(info.total.grams)} г готового блюда, {info.recipe.servings} порц.
        </div>
      </div>
      <div className="section-label">Как готовить</div>
      <div className="card">
        {info.recipe.steps.map((s, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-start', padding: '6px 0' }}>
            <span className="ex-num">{i + 1}</span>
            <span className="p" style={{ marginTop: 3 }}>
              {s}
            </span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function foodName(id: string) {
  return foodById(id)?.name ?? id;
}
