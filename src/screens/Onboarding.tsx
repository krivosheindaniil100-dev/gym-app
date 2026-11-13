import { useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, Box, QrCode, ScanLine, Sparkles, Target, UtensilsCrossed } from 'lucide-react';
import { useApp } from '../lib/store';
import { Chips, NumField, Seg, fmt, toast } from '../ui/kit';
import { completeFields, parseQr } from '../lib/qr';
import { scanCode } from '../lib/native';
import { deurenbergBodyFat, navyBodyFat } from '../lib/energy';
import { GOAL_DEFAULT_PROTEIN, GOAL_DEFAULT_RATE, GOAL_LABEL } from '../lib/nutrition';
import { defaultSmm } from '../body/model';
import type { DietFlag, FoodCategory, Goal } from '../lib/types';

export const ACTIVITY_LEVELS = [
  { v: 1.2, t: 'Сидячий', d: 'Офис, машина, < 5 000 шагов' },
  { v: 1.35, t: 'Немного хожу', d: '5–8 тыс. шагов, бытовые дела' },
  { v: 1.5, t: 'Много на ногах', d: '8–12 тыс. шагов или работа стоя' },
  { v: 1.65, t: 'Физический труд', d: 'Работа, где постоянно двигаешься' },
];

export const DIET_OPTS = [
  { v: 'omnivore', l: 'Ем всё' },
  { v: 'no_pork', l: 'Без свинины' },
  { v: 'pescatarian', l: 'Рыба, без мяса' },
  { v: 'vegetarian', l: 'Вегетарианец' },
] as const;

export const EXCLUDE_OPTS: { v: DietFlag; l: string }[] = [
  { v: 'lactose', l: 'Лактоза' },
  { v: 'gluten', l: 'Глютен' },
  { v: 'nuts', l: 'Орехи' },
  { v: 'fish', l: 'Рыба' },
  { v: 'seafood', l: 'Морепродукты' },
  { v: 'eggs', l: 'Яйца' },
  { v: 'soy', l: 'Соя' },
  { v: 'sugar', l: 'Сахар' },
];

export const LIKE_OPTS: { v: FoodCategory; l: string }[] = [
  { v: 'poultry', l: 'Курица / индейка' },
  { v: 'meat', l: 'Мясо' },
  { v: 'fish', l: 'Рыба' },
  { v: 'seafood', l: 'Морепродукты' },
  { v: 'eggs', l: 'Яйца' },
  { v: 'dairy', l: 'Творог, молочка' },
  { v: 'grains', l: 'Крупы' },
  { v: 'pasta', l: 'Паста' },
  { v: 'legumes', l: 'Бобовые' },
  { v: 'vegetables', l: 'Овощи' },
  { v: 'fruits', l: 'Фрукты' },
  { v: 'berries', l: 'Ягоды' },
];

export default function Onboarding() {
  const st = useApp();
  const [step, setStep] = useState(0);
  const p = st.profile;
  const [weight, setWeight] = useState<number | undefined>();
  const [fatPct, setFatPct] = useState<number | undefined>();
  const [smm, setSmm] = useState<number | undefined>();
  const [knowFat, setKnowFat] = useState<'yes' | 'tape' | 'no'>('yes');
  const [waist, setWaist] = useState<number | undefined>();
  const [neck, setNeck] = useState<number | undefined>();
  const [hips, setHips] = useState<number | undefined>();
  const [qrDate, setQrDate] = useState<string | undefined>();
  const [raw, setRaw] = useState<string | undefined>();
  const age = new Date().getFullYear() - p.birthYear;

  let estFat: number | undefined;
  if (knowFat === 'yes') estFat = fatPct;
  else if (knowFat === 'tape' && waist && neck && (p.sex === 'male' || hips)) estFat = navyBodyFat(p.sex, p.heightCm, waist, neck, hips);
  else if (knowFat === 'no' && weight) estFat = deurenbergBodyFat(p.sex, weight, p.heightCm, age);
  if (estFat !== undefined) estFat = Math.max(3, Math.min(60, estFat));

  const scan = async () => {
    try {
      const r = await scanCode('qr');
      if (!r) return;
      const parsed = parseQr(r, st.qrLearned);
      const c = completeFields(parsed.fields);
      setRaw(r);
      if (parsed.fields.weight) setWeight(parsed.fields.weight);
      if (c) {
        setFatPct(Math.round(c.fatPct * 10) / 10);
        setKnowFat('yes');
        if (c.smm) setSmm(c.smm);
        setQrDate(parsed.date);
        toast('Данные из QR получены');
      } else if (parsed.linkOnly) toast('В QR только ссылка — введите цифры с бланка');
      else toast('Не удалось распознать — введите вручную');
    } catch (e) {
      toast('Сканер недоступен: ' + String((e as Error).message ?? e));
    }
  };

  const finish = () => {
    if (!weight || estFat === undefined) return;
    const fatKg = (weight * estFat) / 100;
    const ffm = weight - fatKg;
    st.addMeasurement({
      date: qrDate ?? new Date().toISOString(),
      source: raw ? 'qr' : 'manual',
      weight,
      fatPct: Math.round(estFat * 10) / 10,
      fatKg: Math.round(fatKg * 100) / 100,
      ffm: Math.round(ffm * 100) / 100,
      smm: smm ?? Math.round(defaultSmm(p.sex, ffm) * 10) / 10,
      raw,
      note: knowFat === 'yes' ? undefined : knowFat === 'tape' ? 'Оценка по обхватам (формула ВМС США)' : 'Оценка по ИМТ',
    });
    st.setOnboarded(true);
  };

  const canNext = [true, p.heightCm > 120 && p.heightCm < 230 && age > 10 && age < 100, !!weight && estFat !== undefined, true, true][step];

  return (
    <div className="onb">
      <div className="steps">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} className={i <= step ? 'on' : ''} />
        ))}
      </div>

      {step === 0 && (
        <>
          <div className="badge accent" style={{ alignSelf: 'flex-start' }}>
            <Sparkles size={12} /> Body Twin
          </div>
          <h1>Твой цифровой двойник</h1>
          <div className="lead">3D-модель тела, которая меняется так же, как меняешься ты: по реальным замерам и по каждой съеденной и потраченной калории.</div>
          <div className="feature">
            <div className="fi">
              <Box size={20} />
            </div>
            <div>
              <b>Тело в 3D, в реальном времени</b>
              <span>Модель строится по весу, % жира и мышцам. Крути, сравнивай с прошлым, смотри прогноз.</span>
            </div>
          </div>
          <div className="feature">
            <div className="fi">
              <QrCode size={20} />
            </div>
            <div>
              <b>Замеры по QR-коду</b>
              <span>Взвесился на медицинских весах — отсканировал код. Дата и показатели сохраняются автоматически.</span>
            </div>
          </div>
          <div className="feature">
            <div className="fi">
              <Target size={20} />
            </div>
            <div>
              <b>Честная математика</b>
              <span>7700 ккал дефицита = 1 кг жира. Модель худеет ровно настолько, насколько ты реально похудел.</span>
            </div>
          </div>
          <div className="feature">
            <div className="fi">
              <UtensilsCrossed size={20} />
            </div>
            <div>
              <b>Питание и тренировки</b>
              <span>Сканер штрихкодов, ввод граммовки с клавиатуры, рецепты под твои БЖУ, программа тренировок под цель.</span>
            </div>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <h1>О тебе</h1>
          <div className="lead">Рост и пол задают скелет 3D-модели и формулы обмена.</div>
          <div className="field">
            <label>Имя (необязательно)</label>
            <input className="input" value={p.name} onChange={(e) => st.setProfile({ name: e.target.value })} placeholder="Как к тебе обращаться" />
          </div>
          <div className="field">
            <label>Пол</label>
            <Seg value={p.sex} options={[{ v: 'male', l: 'Мужской' }, { v: 'female', l: 'Женский' }]} onChange={(v) => st.setProfile({ sex: v })} />
          </div>
          <div className="grid2">
            <div className="field">
              <label>Рост</label>
              <NumField value={p.heightCm} onChange={(v) => v && st.setProfile({ heightCm: v })} suffix="см" />
            </div>
            <div className="field">
              <label>Год рождения</label>
              <NumField value={p.birthYear} onChange={(v) => v && st.setProfile({ birthYear: Math.round(v) })} />
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h1>Тело сейчас</h1>
          <div className="lead">Это стартовая точка. Лучше всего — QR-код с медицинских весов (биоимпеданс).</div>
          <button className="btn primary block" onClick={scan} style={{ marginBottom: 16 }}>
            <ScanLine size={20} /> Сканировать QR с весов
          </button>
          <div className="field">
            <label>Вес</label>
            <NumField value={weight} onChange={setWeight} suffix="кг" placeholder="80,0" />
          </div>
          <div className="field">
            <label>Процент жира</label>
            <Seg
              value={knowFat}
              options={[
                { v: 'yes', l: 'Знаю' },
                { v: 'tape', l: 'По обхватам' },
                { v: 'no', l: 'Не знаю' },
              ]}
              onChange={setKnowFat}
            />
          </div>
          {knowFat === 'yes' && (
            <div className="grid2">
              <div className="field">
                <label>Жир</label>
                <NumField value={fatPct} onChange={setFatPct} suffix="%" placeholder="18" />
              </div>
              <div className="field">
                <label>Скелетные мышцы</label>
                <NumField value={smm} onChange={setSmm} suffix="кг" placeholder="если есть" />
              </div>
            </div>
          )}
          {knowFat === 'tape' && (
            <>
              <div className="grid2">
                <div className="field">
                  <label>Талия (на уровне пупка)</label>
                  <NumField value={waist} onChange={setWaist} suffix="см" />
                </div>
                <div className="field">
                  <label>Шея (под кадыком)</label>
                  <NumField value={neck} onChange={setNeck} suffix="см" />
                </div>
              </div>
              {p.sex === 'female' && (
                <div className="field">
                  <label>Бёдра (по ягодицам)</label>
                  <NumField value={hips} onChange={setHips} suffix="см" />
                </div>
              )}
              <p className="small muted">Формула ВМС США, точность ±3–4%.</p>
            </>
          )}
          {knowFat === 'no' && <p className="small muted">Оценим по ИМТ и возрасту (точность ±5%). Позже обнови по весам — модель пересчитается.</p>}
          {weight && estFat !== undefined && (
            <div className="card glow">
              <div className="kv">
                <span className="k">Жир</span>
                <span className="v">
                  {fmt(estFat, 1)}% · {fmt((weight * estFat) / 100, 1)} кг
                </span>
              </div>
              <div className="kv">
                <span className="k">Безжировая масса</span>
                <span className="v">{fmt(weight * (1 - estFat / 100), 1)} кг</span>
              </div>
            </div>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <h1>Цель и активность</h1>
          <div className="lead">Влияет на норму калорий. Тренировки учитываются отдельно — их добавишь в разделе «Тренировки».</div>
          <div className="section-label" style={{ marginTop: 0 }}>
            <Activity size={12} /> Обычный день без тренировок
          </div>
          {ACTIVITY_LEVELS.map((a) => (
            <button key={a.v} className={`pick ${p.activityFactor === a.v ? 'on' : ''}`} onClick={() => st.setProfile({ activityFactor: a.v })}>
              <div className="grow">
                <div className="pt">{a.t}</div>
                <div className="pd">{a.d}</div>
              </div>
              <span className="badge">×{a.v}</span>
            </button>
          ))}
          <div className="section-label">Цель</div>
          <Chips
            value={p.goal}
            options={(Object.keys(GOAL_LABEL) as Goal[]).map((g) => ({ v: g, l: GOAL_LABEL[g] }))}
            onChange={(g: Goal) =>
              st.setProfile({ goal: g, weeklyRatePct: GOAL_DEFAULT_RATE[g], proteinPerKgFfm: GOAL_DEFAULT_PROTEIN[g], training: { ...p.training, goal: g } })
            }
          />
        </>
      )}

      {step === 4 && (
        <>
          <h1>Что ты любишь есть</h1>
          <div className="lead">По этим предпочтениям приложение будет предлагать блюда под твои БЖУ.</div>
          <div className="section-label" style={{ marginTop: 0 }}>
            Тип питания
          </div>
          <Chips value={p.food.diet} options={DIET_OPTS.map((d) => ({ v: d.v, l: d.l }))} onChange={(v) => st.setProfile({ food: { ...p.food, diet: v } })} />
          <div className="section-label">Исключить</div>
          <Chips multi value={p.food.exclude} options={EXCLUDE_OPTS} onChange={(v) => st.setProfile({ food: { ...p.food, exclude: v } })} />
          <div className="section-label">Люблю</div>
          <Chips multi value={p.food.likes} options={LIKE_OPTS} onChange={(v) => st.setProfile({ food: { ...p.food, likes: v } })} />
          <div className="section-label">Сладкоежка?</div>
          <Seg value={p.food.sweetTooth ? 'y' : 'n'} options={[{ v: 'y', l: 'Да, нужен десерт' }, { v: 'n', l: 'Нет' }]} onChange={(v) => st.setProfile({ food: { ...p.food, sweetTooth: v === 'y' } })} />
          <div className="section-label">Приёмов пищи в день</div>
          <Seg value={p.food.mealsPerDay} options={[3, 4, 5].map((n) => ({ v: n as 3 | 4 | 5, l: String(n) }))} onChange={(v) => st.setProfile({ food: { ...p.food, mealsPerDay: v } })} />
          <div className="section-label">Время на готовку</div>
          <Seg value={p.food.maxCookMinutes} options={[20, 40, 60, 120].map((n) => ({ v: n, l: n === 120 ? 'любое' : `до ${n} мин` }))} onChange={(v) => st.setProfile({ food: { ...p.food, maxCookMinutes: v } })} />
        </>
      )}

      <div className="onb-foot">
        {step > 0 && (
          <button className="btn" onClick={() => setStep(step - 1)} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
        )}
        <button className="btn primary grow" disabled={!canNext} onClick={() => (step < 4 ? setStep(step + 1) : finish())}>
          {step === 0 ? 'Начать' : step < 4 ? 'Далее' : 'Построить моё тело'} <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}
