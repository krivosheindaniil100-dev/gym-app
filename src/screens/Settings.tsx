import { useRef } from 'react';
import { Download, RotateCcw, Upload } from 'lucide-react';
import { exportData, useApp } from '../lib/store';
import { Chips, NumField, Seg, Sheet, Toggle, fmt, toast } from '../ui/kit';
import { ACTIVITY_LEVELS, DIET_OPTS, EXCLUDE_OPTS, LIKE_OPTS } from './Onboarding';
import { shareBackup } from '../lib/native';
import { calibrations } from '../lib/energy';
import { useLedgerInput } from '../lib/hooks';
import { GOAL_DEFAULT_PROTEIN, GOAL_DEFAULT_RATE, GOAL_LABEL } from '../lib/nutrition';
import type { ActivityMode, Goal } from '../lib/types';

export default function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const st = useApp();
  const p = st.profile;
  const fileRef = useRef<HTMLInputElement>(null);
  const input = useLedgerInput();
  const cals = open ? calibrations(input) : [];

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'BodyTwin') throw new Error('Это не резервная копия Body Twin');
      if (!confirm('Заменить все текущие данные данными из файла?')) return;
      st.importAll(data);
      toast('Данные восстановлены');
      onClose();
    } catch (e) {
      toast('Ошибка: ' + String((e as Error).message));
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Настройки" full>
      <div className="section-label" style={{ marginTop: 4 }}>
        Профиль
      </div>
      <div className="card">
        <div className="field">
          <label>Имя</label>
          <input className="input" value={p.name} onChange={(e) => st.setProfile({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>Пол</label>
          <Seg value={p.sex} options={[{ v: 'male', l: 'Мужской' }, { v: 'female', l: 'Женский' }]} onChange={(v) => st.setProfile({ sex: v })} />
        </div>
        <div className="grid2">
          <div className="field">
            <label>Рост</label>
            <NumField value={p.heightCm} onChange={(v) => v && v > 120 && v < 230 && st.setProfile({ heightCm: v })} suffix="см" />
          </div>
          <div className="field">
            <label>Год рождения</label>
            <NumField value={p.birthYear} onChange={(v) => v && v > 1920 && st.setProfile({ birthYear: Math.round(v) })} />
          </div>
        </div>
      </div>

      <div className="section-label">Цель</div>
      <div className="card">
        <Chips
          value={p.goal}
          options={(Object.keys(GOAL_LABEL) as Goal[]).map((g) => ({ v: g, l: GOAL_LABEL[g] }))}
          onChange={(g: Goal) => st.setProfile({ goal: g, weeklyRatePct: GOAL_DEFAULT_RATE[g], proteinPerKgFfm: GOAL_DEFAULT_PROTEIN[g] })}
        />
        <div className="field" style={{ marginTop: 14 }}>
          <label>
            Темп: {p.weeklyRatePct > 0 ? '+' : ''}
            {fmt(p.weeklyRatePct, 2)}% веса в неделю
          </label>
          <input type="range" min={-1.2} max={0.75} step={0.05} value={p.weeklyRatePct} onChange={(e) => st.setProfile({ weeklyRatePct: Number(e.target.value) })} />
        </div>
        <div className="grid2">
          <div className="field">
            <label>Белок, г на кг сухой массы</label>
            <NumField value={p.proteinPerKgFfm} onChange={(v) => v && st.setProfile({ proteinPerKgFfm: v })} />
          </div>
          <div className="field">
            <label>Жиры, г на кг веса</label>
            <NumField value={p.fatPerKgBw} onChange={(v) => v && st.setProfile({ fatPerKgBw: v })} />
          </div>
        </div>
        <div className="field">
          <label>Целевой % жира (для прогноза)</label>
          <NumField value={p.targetFatPct} onChange={(v) => st.setProfile({ targetFatPct: v })} suffix="%" placeholder="например 12" />
        </div>
      </div>

      <div className="section-label">Как считать расход</div>
      <div className="card">
        <Seg<ActivityMode>
          value={p.activityMode}
          options={[
            { v: 'lifestyle', l: 'Образ жизни' },
            { v: 'steps', l: 'Шаги' },
            { v: 'watch', l: 'Часы' },
          ]}
          onChange={(v) => st.setProfile({ activityMode: v })}
        />
        <p className="p" style={{ marginTop: 10 }}>
          {p.activityMode === 'lifestyle' && 'Базовый обмен × коэффициент образа жизни + тренировки, записанные в приложении.'}
          {p.activityMode === 'steps' && 'Базовый обмен × 1,15 + шаги за день (вводишь в разделе «Питание» → расход) + тренировки.'}
          {p.activityMode === 'watch' && 'Базовый обмен × 1,1 + «активные калории» из Samsung Health / часов. Тренировки из приложения не добавляются повторно — часы их уже посчитали.'}
        </p>
        {p.activityMode === 'lifestyle' &&
          ACTIVITY_LEVELS.map((a) => (
            <button key={a.v} className={`pick ${p.activityFactor === a.v ? 'on' : ''}`} onClick={() => st.setProfile({ activityFactor: a.v })}>
              <div className="grow">
                <div className="pt">{a.t}</div>
                <div className="pd">{a.d}</div>
              </div>
              <span className="badge">×{a.v}</span>
            </button>
          ))}
        <div className="divider" />
        <div className="row between">
          <div className="grow">
            <div className="bold">Автокоррекция расхода по замерам</div>
            <div className="small muted" style={{ marginTop: 3 }}>
              Сравнивает прогноз 7700-модели с реальными замерами (≥ 2 недели, ≥ 70% дней заполнено) и уточняет твой реальный расход. Правило 7700 ккал = 1 кг не меняется.
            </div>
          </div>
          <Toggle on={p.calibrate} onChange={(v) => st.setProfile({ calibrate: v })} />
        </div>
        {cals.length > 0 && (
          <div className="small" style={{ marginTop: 10 }}>
            {cals.slice(-3).map((c, i) => (
              <div className="kv" key={i}>
                <span className="k">
                  {new Date(c.from.date).toLocaleDateString('ru-RU')} → {new Date(c.to.date).toLocaleDateString('ru-RU')}
                </span>
                <span className="v">
                  {c.biasPerDay >= 0 ? '+' : '−'}
                  {fmt(Math.abs(c.biasPerDay))} ккал/день
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-label">Питание</div>
      <div className="card">
        <Chips value={p.food.diet} options={DIET_OPTS.map((d) => ({ v: d.v, l: d.l }))} onChange={(v) => st.setProfile({ food: { ...p.food, diet: v } })} />
        <div className="small muted" style={{ margin: '14px 0 8px' }}>
          Исключить
        </div>
        <Chips multi value={p.food.exclude} options={EXCLUDE_OPTS} onChange={(v) => st.setProfile({ food: { ...p.food, exclude: v } })} />
        <div className="small muted" style={{ margin: '14px 0 8px' }}>
          Люблю
        </div>
        <Chips multi value={p.food.likes} options={LIKE_OPTS} onChange={(v) => st.setProfile({ food: { ...p.food, likes: v } })} />
        <div className="row between" style={{ marginTop: 14 }}>
          <span className="bold">Сладкоежка</span>
          <Toggle on={p.food.sweetTooth} onChange={(v) => st.setProfile({ food: { ...p.food, sweetTooth: v } })} />
        </div>
        <div className="small muted" style={{ margin: '14px 0 8px' }}>
          Приёмов пищи
        </div>
        <Seg value={p.food.mealsPerDay} options={[3, 4, 5].map((n) => ({ v: n as 3 | 4 | 5, l: String(n) }))} onChange={(v) => st.setProfile({ food: { ...p.food, mealsPerDay: v } })} />
        <div className="small muted" style={{ margin: '14px 0 8px' }}>
          Время на готовку
        </div>
        <Seg value={p.food.maxCookMinutes} options={[20, 40, 60, 120].map((n) => ({ v: n, l: n === 120 ? 'любое' : `${n} мин` }))} onChange={(v) => st.setProfile({ food: { ...p.food, maxCookMinutes: v } })} />
      </div>

      <div className="section-label">Данные</div>
      <div className="card">
        <p className="p" style={{ marginTop: 0 }}>
          Все данные хранятся только на телефоне. Делай резервную копию перед переустановкой приложения.
        </p>
        <div className="grid2">
          <button className="btn" onClick={() => shareBackup(exportData()).catch((e) => toast(String(e)))}>
            <Download size={18} /> Экспорт
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={18} /> Импорт
          </button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        <button
          className="btn danger block"
          style={{ marginTop: 10 }}
          onClick={() => {
            if (confirm('Удалить все данные и начать заново?')) {
              st.resetAll();
              onClose();
            }
          }}
        >
          <RotateCcw size={18} /> Сбросить всё
        </button>
      </div>

      <div className="section-label">Как это считается</div>
      <div className="card p">
        <p style={{ marginTop: 0 }}>
          <b>Основа — замеры.</b> Каждый замер с весов — это «истина». Между замерами состав тела считается по дневнику: Δжир = Σ(съедено − потрачено) / 7700 ккал. Мышцы меняются только по реальным замерам.
        </p>
        <p>
          <b>Расход</b> = базовый обмен по формуле Кэтча–МакАрдла (370 + 21,6 × сухая масса) × образ жизни + тренировки по MET (чистый расход сверх покоя).
        </p>
        <p>
          <b>3D-модель:</b> скелет по росту и полу, мышечный «каркас» по сухой массе и скелетным мышцам, жир распределяется по объёму (0,9 кг/л) по реальным депо: у мужчин сначала живот и бока, у женщин бёдра и ягодицы; висцеральный жир выдвигает живот. Пресс проявляется, когда подкожный слой на животе тоньше ~1 см.
        </p>
        <p style={{ marginBottom: 0 }}>Дни без записей еды не учитываются, чтобы забытый дневник не выглядел как голодовка.</p>
      </div>
      <div className="tiny muted" style={{ textAlign: 'center', margin: '8px 0 16px' }}>
        Body Twin 1.0 · для личного использования
      </div>
    </Sheet>
  );
}
