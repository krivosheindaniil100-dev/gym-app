import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Dumbbell, History, Info, Play, Plus, Repeat, Settings2, Timer, Trash2, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { alternatives, exById, generatePlan, MUSCLE_LABEL, sessionKcal } from '../lib/training';
import { Chips, NumField, Seg, Sheet, fmt, toast } from '../ui/kit';
import { dayKey, fmtDay, fmtDateTime, uid, weekdayMon, WEEKDAYS_MON } from '../lib/date';
import { useLive, useNow } from '../lib/hooks';
import { GOAL_LABEL } from '../lib/nutrition';
import { success, tap } from '../lib/native';
import type { Goal, JointStress, MuscleGroup, PlannedDay, TrainingPrefs, WorkoutSession } from '../lib/types';

const PRIORITY_OPTS: MuscleGroup[] = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'abs', 'glutes', 'quads', 'hamstrings', 'calves'];
const AVOID_OPTS: { v: JointStress; l: string }[] = [
  { v: 'knees', l: 'Колени' },
  { v: 'lower_back', l: 'Поясница' },
  { v: 'shoulders', l: 'Плечи' },
  { v: 'elbows', l: 'Локти' },
  { v: 'wrists', l: 'Запястья' },
];

export default function TrainingScreen({ active }: { active: boolean }) {
  const plan = useApp((s) => s.plan);
  const sessions = useApp((s) => s.sessions);
  const activeSession = useApp((s) => s.activeSession);
  const [quiz, setQuiz] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [swap, setSwap] = useState<{ dayId: string; idx: number } | null>(null);
  const [showHist, setShowHist] = useState(false);
  const now = useNow(60000);
  const live = useLive(now);
  const startSession = useApp((s) => s.startSession);

  const today = dayKey(now);
  const wd = weekdayMon(today);
  const todayDayId = plan?.schedule[wd];
  const todayDay = plan && todayDayId && todayDayId !== 'rest' ? plan.days.find((d) => d.id === todayDayId) : null;
  const weekStart = useMemo(() => {
    const d = new Date(now);
    d.setDate(d.getDate() - wd);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [today]);
  const doneThisWeek = new Set(sessions.filter((s) => new Date(s.date) >= weekStart).map((s) => weekdayMon(dayKey(s.date))));

  const begin = (day: PlannedDay) => {
    if (activeSession) return;
    const last = (exId: string) => {
      for (let i = sessions.length - 1; i >= 0; i--) {
        const e = sessions[i].exercises.find((x) => x.exerciseId === exId);
        if (e) return e;
      }
      return null;
    };
    const s: WorkoutSession = {
      id: uid(),
      date: new Date().toISOString(),
      dayId: day.id,
      dayName: day.name,
      minutes: 0,
      intensity: plan!.prefs.intensity,
      exercises: day.exercises.map((pe) => {
        const prev = last(pe.exerciseId);
        const ex = exById(pe.exerciseId);
        return {
          exerciseId: pe.exerciseId,
          sets: Array.from({ length: pe.sets }, (_, i) => ({
            weight: prev?.sets[i]?.weight ?? prev?.sets[0]?.weight ?? ex?.startKg ?? 0,
            reps: prev?.sets[i]?.reps ?? pe.repMax,
            done: false,
          })),
        };
      }),
      kcal: 0,
      finished: false,
    };
    startSession(s);
    tap();
  };

  return (
    <div className={`screen ${active ? 'screen-enter' : ''}`}>
      <div className="topbar">
        <div>
          <h1>Тренировки</h1>
          <div className="sub">{plan ? `${plan.splitName} · ${GOAL_LABEL[plan.prefs.goal].toLowerCase()}` : 'Программа под твою цель'}</div>
        </div>
        <div className="row">
          {sessions.length > 0 && (
            <button className="icon-btn" onClick={() => setShowHist(true)} aria-label="История">
              <History size={20} />
            </button>
          )}
          {plan && (
            <button className="icon-btn" onClick={() => setQuiz(true)} aria-label="Настроить программу">
              <Settings2 size={20} />
            </button>
          )}
        </div>
      </div>

      {!plan && (
        <div className="card glow">
          <div className="empty" style={{ padding: '14px 4px' }}>
            <div className="icon">
              <Dumbbell size={26} />
            </div>
            <h3>Составим программу под тебя</h3>
            <div className="small" style={{ lineHeight: 1.5 }}>
              Цель, сколько дней готов заниматься, где тренируешься, что болит и что хочешь подтянуть — и получишь план с подходами, повторами и отдыхом.
            </div>
            <button className="btn primary" style={{ marginTop: 16 }} onClick={() => setQuiz(true)}>
              Составить программу
            </button>
          </div>
        </div>
      )}

      {plan && (
        <>
          <div className="week-strip" style={{ marginBottom: 12 }}>
            {WEEKDAYS_MON.map((w, i) => {
              const id = plan.schedule[i];
              const train = id !== 'rest';
              return (
                <div key={w} className={`week-day ${train ? 'train' : ''} ${i === wd ? 'today' : ''} ${doneThisWeek.has(i) ? 'done' : ''}`}>
                  {w}
                  <span className="wd-dot" />
                </div>
              );
            })}
          </div>

          <div className="card glow">
            <div className="small muted bold" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Сегодня
            </div>
            {todayDay ? (
              <>
                <div className="bold" style={{ fontSize: 22, margin: '4px 0' }}>
                  {todayDay.name}
                </div>
                <div className="small muted">
                  {todayDay.focus} · ~{todayDay.estMinutes} мин · {todayDay.exercises.length} упражнений · ≈ {fmt(sessionKcal(todayDay.estMinutes, plan.prefs.intensity, live?.weight ?? 75))} ккал
                </div>
                <button className="btn primary block" style={{ marginTop: 14 }} onClick={() => begin(todayDay)} disabled={!!activeSession}>
                  <Play size={18} /> {activeSession ? 'Тренировка уже идёт' : 'Начать тренировку'}
                </button>
              </>
            ) : (
              <>
                <div className="bold" style={{ fontSize: 20, margin: '4px 0' }}>
                  День отдыха
                </div>
                <div className="small muted">Восстановление — часть прогресса. Прогулка 8–10 тыс. шагов будет кстати.</div>
              </>
            )}
          </div>

          <div className="section-label">Программа на неделю</div>
          {plan.days.map((d) => {
            const isOpen = openDay === d.id;
            const days = plan.schedule.map((x, i) => (x === d.id ? WEEKDAYS_MON[i] : null)).filter(Boolean);
            return (
              <div className="card" key={d.id}>
                <button className="row between" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpenDay(isOpen ? null : d.id)}>
                  <div>
                    <div className="bold" style={{ fontSize: 16 }}>
                      {d.name} <span className="badge">{days.join(', ')}</span>
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>
                      {d.focus} · ~{d.estMinutes} мин
                    </div>
                  </div>
                  {isOpen ? <ChevronUp size={20} className="muted" /> : <ChevronDown size={20} className="muted" />}
                </button>
                {isOpen && (
                  <div style={{ marginTop: 8 }}>
                    {d.exercises.map((pe, i) => {
                      const ex = exById(pe.exerciseId);
                      if (!ex) return null;
                      return (
                        <div className="ex-row" key={i}>
                          <span className="ex-num">{i + 1}</span>
                          <div className="grow" style={{ minWidth: 0 }}>
                            <div className="bold">{ex.name}</div>
                            <div className="small" style={{ color: 'var(--accent)', marginTop: 2 }}>
                              {pe.sets} × {pe.repMin}–{pe.repMax}
                              {ex.timed ? ' сек' : ex.unilateral ? ' на сторону' : ''} · отдых {fmtRest(pe.restSec)} · RIR {pe.rir}
                            </div>
                            <div className="tiny muted" style={{ marginTop: 3 }}>
                              {ex.primary.map((m) => MUSCLE_LABEL[m]).join(', ')}
                            </div>
                            {pe.note && <div className="tiny muted" style={{ marginTop: 3, fontStyle: 'italic' }}>{pe.note}</div>}
                          </div>
                          <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={() => setSwap({ dayId: d.id, idx: i })} aria-label="Заменить">
                            <Repeat size={16} />
                          </button>
                        </div>
                      );
                    })}
                    {d.cardio && (
                      <div className="ex-row">
                        <span className="ex-num">♥</span>
                        <div className="grow">
                          <div className="bold">{d.cardio.name}</div>
                          <div className="small" style={{ color: 'var(--accent)' }}>
                            {d.cardio.minutes} мин после силовой
                          </div>
                          <div className="tiny muted">{d.cardio.note}</div>
                        </div>
                      </div>
                    )}
                    <button className="btn sm block" style={{ marginTop: 10 }} onClick={() => begin(d)} disabled={!!activeSession}>
                      <Play size={16} /> Начать этот день
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          <div className="section-label">Объём за неделю (рабочих подходов)</div>
          <div className="card">
            {(Object.entries(plan.weeklySets) as [MuscleGroup, number][])
              .filter(([, v]) => v >= 2)
              .sort((a, b) => b[1] - a[1])
              .map(([m, v]) => {
                const pct = Math.min(100, (v / 22) * 100);
                const zone = v < 8 ? 'var(--amber)' : v <= 20 ? 'var(--accent)' : 'var(--rose)';
                return (
                  <div key={m} style={{ marginBottom: 9 }}>
                    <div className="row between small" style={{ marginBottom: 4 }}>
                      <span>{MUSCLE_LABEL[m]}</span>
                      <span className="num bold">{fmt(v, v % 1 ? 1 : 0)}</span>
                    </div>
                    <div className="macro-bar">
                      <div style={{ width: `${pct}%`, background: zone }} />
                    </div>
                  </div>
                );
              })}
            <div className="tiny muted" style={{ marginTop: 6 }}>
              Ориентир для роста и сохранения мышц — 10–20 подходов в неделю на крупную группу. Вспомогательная работа считается за 0,5.
            </div>
          </div>

          <div className="section-label">Почему так</div>
          <div className="card">
            {[...plan.rationale, ...plan.tips].map((r, i) => (
              <div key={i} className="row p" style={{ alignItems: 'flex-start', padding: '5px 0' }}>
                <Info size={15} style={{ flex: 'none', marginTop: 3, color: 'var(--accent)' }} />
                <span>{r}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <QuizSheet open={quiz} onClose={() => setQuiz(false)} />
      <SwapSheet data={swap} onClose={() => setSwap(null)} />
      <HistorySheet open={showHist} onClose={() => setShowHist(false)} />
      {activeSession && <SessionView />}
    </div>
  );
}

function fmtRest(s: number) {
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`;
}

/* ───────────────────────── Questionnaire ───────────────────────── */

function QuizSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const profile = useApp((s) => s.profile);
  const setProfile = useApp((s) => s.setProfile);
  const setPlan = useApp((s) => s.setPlan);
  const [p, setP] = useState<TrainingPrefs>(profile.training);
  useEffect(() => {
    if (open) setP({ ...profile.training, goal: profile.goal });
  }, [open]);
  const set = (x: Partial<TrainingPrefs>) => setP({ ...p, ...x });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      full
      title="Моя программа"
      footer={
        <button
          className="btn primary block"
          onClick={() => {
            setProfile({ training: p });
            setPlan(generatePlan(p));
            success();
            toast('Программа готова');
            onClose();
          }}
        >
          <Dumbbell size={18} /> Составить программу
        </button>
      }
    >
      <div className="section-label" style={{ marginTop: 0 }}>
        Цель
      </div>
      <Chips value={p.goal} options={(Object.keys(GOAL_LABEL) as Goal[]).map((g) => ({ v: g, l: GOAL_LABEL[g] }))} onChange={(g) => set({ goal: g })} />
      <div className="section-label">Опыт</div>
      <Seg
        value={p.experience}
        options={[
          { v: 'novice', l: 'до 6 мес' },
          { v: 'intermediate', l: '6 мес – 2 года' },
          { v: 'advanced', l: '2+ года' },
        ]}
        onChange={(v) => set({ experience: v })}
      />
      <div className="section-label">Дней в неделю</div>
      <Seg value={p.daysPerWeek} options={[2, 3, 4, 5, 6].map((n) => ({ v: n as TrainingPrefs['daysPerWeek'], l: String(n) }))} onChange={(v) => set({ daysPerWeek: v })} />
      <div className="section-label">Длительность силовой части</div>
      <Seg value={p.sessionMinutes} options={[30, 45, 60, 75, 90].map((n) => ({ v: n as TrainingPrefs['sessionMinutes'], l: `${n}` }))} onChange={(v) => set({ sessionMinutes: v })} />
      <div className="section-label">Где тренируешься</div>
      <Seg
        value={p.place}
        options={[
          { v: 'gym', l: 'Зал' },
          { v: 'home_dumbbells', l: 'Дом + гантели' },
          { v: 'home_bodyweight', l: 'Дом без железа' },
        ]}
        onChange={(v) => set({ place: v })}
      />
      <div className="section-label">Насколько тяжело</div>
      <Seg
        value={p.intensity}
        options={[
          { v: 'light', l: 'Щадяще' },
          { v: 'moderate', l: 'Нормально' },
          { v: 'hard', l: 'На максимум' },
        ]}
        onChange={(v) => set({ intensity: v })}
      />
      <div className="section-label">Хочу подтянуть (приоритет)</div>
      <Chips multi value={p.priority} options={PRIORITY_OPTS.map((m) => ({ v: m, l: MUSCLE_LABEL[m] }))} onChange={(v) => set({ priority: v })} />
      <div className="section-label">Беречь (травмы, боль)</div>
      <Chips multi value={p.avoid} options={AVOID_OPTS} onChange={(v) => set({ avoid: v })} />
      <div className="section-label">Кардио</div>
      <Seg
        value={p.cardio}
        options={[
          { v: 'none', l: 'Без кардио' },
          { v: 'after', l: 'После силовой' },
          { v: 'separate', l: 'Отдельно' },
        ]}
        onChange={(v) => set({ cardio: v })}
      />
      {p.goal === 'cut' && (
        <div className="note info" style={{ marginTop: 14 }}>
          <Info size={16} />
          <div>На сушке жир сжигает дефицит калорий, а тренировки нужны, чтобы сохранить мышцы. Поэтому в программе остаются тяжёлые базовые упражнения.</div>
        </div>
      )}
    </Sheet>
  );
}

function SwapSheet({ data, onClose }: { data: { dayId: string; idx: number } | null; onClose: () => void }) {
  const plan = useApp((s) => s.plan);
  const setPlan = useApp((s) => s.setPlan);
  if (!plan || !data) return null;
  const day = plan.days.find((d) => d.id === data.dayId)!;
  const pe = day.exercises[data.idx];
  const cur = exById(pe.exerciseId);
  const alts = alternatives(pe.exerciseId, plan.prefs);
  return (
    <Sheet open={!!data} onClose={onClose} title="Заменить упражнение">
      <div className="small muted" style={{ marginBottom: 8 }}>
        Сейчас: <b style={{ color: 'var(--text)' }}>{cur?.name}</b>
      </div>
      <div className="list">
        {alts.map((a) => (
          <div
            key={a.id}
            className="item"
            role="button"
            onClick={() => {
              const days = plan.days.map((d) => (d.id === day.id ? { ...d, exercises: d.exercises.map((x, i) => (i === data.idx ? { ...x, exerciseId: a.id, note: a.cue } : x)) } : d));
              setPlan({ ...plan, days });
              toast('Упражнение заменено');
              onClose();
            }}
          >
            <div className="grow">
              <div className="title">{a.name}</div>
              <div className="meta">{a.primary.map((m) => MUSCLE_LABEL[m]).join(', ')}</div>
            </div>
            <Repeat size={16} className="muted" />
          </div>
        ))}
        {!alts.length && <div className="small muted">Нет альтернатив с текущим инвентарём.</div>}
      </div>
    </Sheet>
  );
}

/* ───────────────────────── Active session ───────────────────────── */

function SessionView() {
  const s = useApp((x) => x.activeSession)!;
  const plan = useApp((x) => x.plan);
  const update = useApp((x) => x.updateSession);
  const finish = useApp((x) => x.finishSession);
  const cancel = useApp((x) => x.cancelSession);
  const now = useNow(1000);
  const live = useLive(now);
  const [rest, setRest] = useState<{ until: number; total: number } | null>(null);
  const elapsedMin = Math.max(1, Math.round((now.getTime() - new Date(s.date).getTime()) / 60000));
  const day = plan?.days.find((d) => d.id === s.dayId);
  const doneSets = s.exercises.reduce((a, e) => a + e.sets.filter((x) => x.done).length, 0);
  const totalSets = s.exercises.reduce((a, e) => a + e.sets.length, 0);

  const setSet = (ei: number, si: number, patch: Partial<{ weight: number; reps: number; done: boolean }>) => {
    const exercises = s.exercises.map((e, i) => (i === ei ? { ...e, sets: e.sets.map((x, j) => (j === si ? { ...x, ...patch } : x)) } : e));
    update({ ...s, exercises });
  };

  const left = rest ? Math.max(0, Math.round((rest.until - now.getTime()) / 1000)) : 0;
  useEffect(() => {
    if (rest && left === 0) {
      success();
      setRest(null);
    }
  }, [left]);

  return (
    <Sheet
      open
      onClose={() => {}}
      full
      title={s.dayName}
      right={
        <span className="badge accent num">
          <Timer size={12} /> {elapsedMin} мин
        </span>
      }
      footer={
        <div className="row">
          <button
            className="btn danger"
            onClick={() => {
              if (confirm('Отменить тренировку без сохранения?')) cancel();
            }}
            aria-label="Отменить"
          >
            <X size={18} />
          </button>
          <button
            className="btn primary grow"
            disabled={doneSets === 0}
            onClick={() => {
              const minutes = elapsedMin;
              const kcal = Math.round(sessionKcal(minutes, s.intensity, live?.weight ?? 75));
              finish({ ...s, minutes, kcal });
              toast(`Тренировка сохранена: ${minutes} мин, ${kcal} ккал`);
            }}
          >
            <Check size={18} /> Завершить · {doneSets}/{totalSets} подходов
          </button>
        </div>
      }
    >
      {s.exercises.map((e, ei) => {
        const ex = exById(e.exerciseId);
        const pe = day?.exercises.find((x) => x.exerciseId === e.exerciseId);
        return (
          <div className="card" key={ei}>
            <div className="bold">{ex?.name}</div>
            <div className="small" style={{ color: 'var(--accent)', marginTop: 2 }}>
              {pe ? `${pe.repMin}–${pe.repMax}${ex?.timed ? ' сек' : ' повт.'} · RIR ${pe.rir} · отдых ${fmtRest(pe.restSec)}` : ''}
            </div>
            {ex?.cue && <div className="tiny muted" style={{ marginTop: 3 }}>{ex.cue}</div>}
            <div className="set-row tiny muted bold" style={{ marginTop: 10 }}>
              <span>#</span>
              <span style={{ textAlign: 'center' }}>кг</span>
              <span style={{ textAlign: 'center' }}>{ex?.timed ? 'сек' : 'повторы'}</span>
              <span />
            </div>
            {e.sets.map((st, si) => (
              <div className="set-row" key={si}>
                <span className="ex-num" style={{ width: 26, height: 26 }}>
                  {si + 1}
                </span>
                <NumField value={st.weight} onChange={(v) => setSet(ei, si, { weight: v ?? 0 })} />
                <NumField value={st.reps} onChange={(v) => setSet(ei, si, { reps: v ?? 0 })} />
                <button
                  className={`set-check ${st.done ? 'on' : ''}`}
                  onClick={() => {
                    tap();
                    setSet(ei, si, { done: !st.done });
                    if (!st.done && pe) setRest({ until: Date.now() + pe.restSec * 1000, total: pe.restSec });
                  }}
                  aria-label="Подход выполнен"
                >
                  <Check size={20} />
                </button>
              </div>
            ))}
            <button
              className="add-line"
              onClick={() => {
                const last = e.sets[e.sets.length - 1];
                const exercises = s.exercises.map((x, i) => (i === ei ? { ...x, sets: [...x.sets, { ...last, done: false }] } : x));
                update({ ...s, exercises });
              }}
            >
              <Plus size={16} /> подход
            </button>
          </div>
        );
      })}
      {rest && left > 0 && (
        <div className="rest-timer">
          <Timer size={18} style={{ color: 'var(--accent)' }} />
          Отдых {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          <button className="btn sm" onClick={() => setRest({ ...rest, until: rest.until + 30000 })}>
            +30 с
          </button>
          <button className="icon-btn" style={{ width: 34, height: 34 }} onClick={() => setRest(null)} aria-label="Пропустить">
            <X size={16} />
          </button>
        </div>
      )}
    </Sheet>
  );
}

function HistorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const del = useApp((s) => s.deleteSession);
  const list = [...sessions].reverse();
  return (
    <Sheet open={open} onClose={onClose} title="История тренировок" full>
      {list.map((s) => {
        const vol = s.exercises.reduce((a, e) => a + e.sets.filter((x) => x.done).reduce((b, x) => b + x.weight * x.reps, 0), 0);
        return (
          <div className="card" key={s.id}>
            <div className="row between">
              <div>
                <div className="bold">{s.dayName}</div>
                <div className="small muted">
                  {fmtDateTime(s.date)} · {s.minutes} мин · {fmt(s.kcal)} ккал · объём {fmt(vol)} кг
                </div>
              </div>
              <button
                className="icon-btn"
                onClick={() => {
                  if (confirm('Удалить тренировку?')) del(s.id);
                }}
                aria-label="Удалить"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="divider" />
            {s.exercises.map((e, i) => {
              const done = e.sets.filter((x) => x.done);
              if (!done.length) return null;
              return (
                <div key={i} className="kv small">
                  <span className="k">{exById(e.exerciseId)?.name}</span>
                  <span className="v">{done.map((x) => `${fmt(x.weight, x.weight % 1 ? 1 : 0)}×${x.reps}`).join(', ')}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {!list.length && <div className="empty">Пока пусто</div>}
      <div className="tiny muted" style={{ textAlign: 'center' }}>
        Тренировки автоматически добавляются в расход калорий за день ({fmtDay(new Date())}).
      </div>
    </Sheet>
  );
}
