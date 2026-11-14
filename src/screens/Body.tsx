import { useMemo, useState } from 'react';
import { AlertTriangle, Flame, Ghost, History, Info, Plus, QrCode, Ruler, ScanFace, Settings as Gear, TrendingDown, TrendingUp, UserRound } from 'lucide-react';
import HumanViewer from '../human/HumanViewer';
import type { Girth } from '../human/human.worker';
import { buildBody } from '../body/model';
import { measureBody } from '../body/measure';
import { appearanceOf, avatarOf, humanInputFor } from '../human/avatar';
import AvatarSheet from './Avatar';
import PhotoFitSheet from './PhotoFit';
import FaceFitSheet from './FaceFit';
import { useApp } from '../lib/store';
import { useLedgerInput, useLive, useNow, useTargets, useBias } from '../lib/hooks';
import { bmi, compFromMeasurement, dailyBalances, fatCategory, ffmi, forecast, KCAL_PER_KG_FAT, liveState, recentAvgBalance, sortedMeasurements, type Composition } from '../lib/energy';
import { addDays, dayKey, fmtDateTime, fmtDay, fromKey, monthName } from '../lib/date';
import { parseQr, type QrParse } from '../lib/qr';
import { scanCode, tap } from '../lib/native';
import { fmt, Ring, signed, toast } from '../ui/kit';
import MeasurementSheet from './MeasurementSheet';
import SettingsSheet from './Settings';
import type { Tab } from '../App';

const FORECAST_DAYS = 84;


export default function BodyScreen({ active, onNavigate }: { active: boolean; onNavigate: (t: Tab) => void }) {
  const now = useNow(30000);
  const profile = useApp((s) => s.profile);
  const learned = useApp((s) => s.qrLearned);
  const input = useLedgerInput();
  const bias = useBias();
  const live = useLive(now);
  const targets = useTargets(live);
  const ms = useMemo(() => sortedMeasurements(input.measurements), [input.measurements]);
  const first = ms[0];

  const [t, setT] = useState(0); // days relative to today
  const [rings, setRings] = useState(false);
  const [compare, setCompare] = useState(false);
  const [view, setView] = useState<{ name: 'front' | 'side' | 'back' | 'face'; nonce: number }>();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [faceOpen, setFaceOpen] = useState(false);
  const [girths, setGirths] = useState<Girth[]>([]);
  const [qr, setQr] = useState<QrParse | null>(null);
  const [mOpen, setMOpen] = useState(false);
  const [settings, setSettings] = useState(false);

  const minT = first ? Math.min(0, -Math.ceil((now.getTime() - new Date(first.date).getTime()) / 86400000)) : 0;

  const recent = useMemo(() => recentAvgBalance(input, 14), [input]);
  const pace = recent ? { avg: recent.avg, src: 'по факту 14 дн.' } : targets ? { avg: targets.dailyDelta, src: 'по плану питания' } : null;

  // composition at the selected moment
  const shown: { comp: Composition; mode: 'live' | 'history' | 'forecast'; label: string } | null = useMemo(() => {
    if (!live) return null;
    if (t === 0) return { comp: live, mode: 'live', label: 'Сейчас' };
    if (t < 0) {
      const at = new Date(fromKey(addDays(dayKey(now), t)).getTime() + 20 * 3600 * 1000);
      const st = liveState(input, at, bias);
      if (!st) return { comp: compFromMeasurement(first!), mode: 'history', label: fmtDay(first!.date, true) };
      return { comp: st, mode: 'history', label: fmtDay(addDays(dayKey(now), t), true) };
    }
    const fc = forecast(live, pace?.avg ?? 0, t);
    return { comp: fc, mode: 'forecast', label: fmtDay(addDays(dayKey(now), t), true) };
  }, [t, live, input, bias, now.getTime(), pace?.avg]);

  const bodyInput = shown ? humanInputFor(profile, shown.comp) : null;
  const ghostInput = useMemo(() => {
    if (!compare || !live) return null;
    if (t === 0 && first) return humanInputFor(profile, compFromMeasurement(first));
    return humanInputFor(profile, live);
  }, [compare, t, live?.fatKg, first?.id, profile]);
  const appearance = appearanceOf(avatarOf(profile));

  // physics girth ratios start → shown (to show how much each girth changed since the start)
  const startRatio = useMemo(() => {
    if (!first || !shown) return null;
    try {
      const a = measureBody(buildBody(humanInputFor(profile, compFromMeasurement(first))));
      const b = measureBody(buildBody(humanInputFor(profile, shown.comp)));
      const r: Record<string, number> = {};
      for (const g of b) {
        const s0 = a.find((x) => x.key === g.key);
        if (s0) r[g.key] = s0.cm / g.cm;
      }
      return r;
    } catch {
      return null;
    }
  }, [first?.id, shown?.comp.fatKg, shown?.comp.ffm, profile.sex, profile.heightCm, profile.avatar?.pattern]);

  const today = dayKey(now);
  const todayBal = useMemo(() => dailyBalances(input, today, today, bias)[0], [input, today, now.getTime(), bias]);
  const monthBal = useMemo(() => {
    const start = today.slice(0, 8) + '01';
    const days = dailyBalances(input, start < (first ? dayKey(first.date) : start) ? dayKey(first!.date) : start, today, bias);
    const logged = days.filter((d) => d.logged);
    return { balance: logged.reduce((s, d) => s + d.balance, 0), logged: logged.length, total: days.length };
  }, [input, today, bias, first?.id]);

  const startQr = async () => {
    tap();
    try {
      const raw = await scanCode('qr');
      if (!raw) return;
      setQr(parseQr(raw, learned));
      setMOpen(true);
    } catch (e) {
      toast('Сканер недоступен: ' + String((e as Error).message ?? e));
    }
  };

  if (!live || !shown || !bodyInput) return null;
  const c = shown.comp;
  const cat = fatCategory(profile.sex, c.fatPct);
  const anchor = live.anchor;
  const fatG = live.fatDelta * 1000;
  const toNextKg = Math.abs(live.balanceSinceAnchor) % KCAL_PER_KG_FAT;
  const hello = profile.name ? `Привет, ${profile.name}` : 'Моё тело';
  const nowFrac = minT < 0 ? (-minT / (FORECAST_DAYS - minT)) * 100 : 0;

  return (
    <div className={`screen ${active ? 'screen-enter' : ''}`}>
      <div className="topbar">
        <div>
          <h1>{hello}</h1>
          <div className="sub">
            {now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
        </div>
        <div className="row">
          <button className="icon-btn accent" onClick={startQr} aria-label="Сканировать QR">
            <QrCode size={20} />
          </button>
          <button className="icon-btn" onClick={() => setAvatarOpen(true)} aria-label="Мой аватар">
            <UserRound size={20} />
          </button>
          <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Настройки">
            <Gear size={20} />
          </button>
        </div>
      </div>

      <div className="hero">
        <HumanViewer input={bodyInput} ghost={ghostInput} appearance={appearance} showRings={rings} view={view} onMeasured={(_, g) => setGirths(g)} />
        <div className="hero-overlay">
          <div className="hero-stats">
            <div>
              <div className="hero-cap">Вес</div>
              <div className="hero-num">
                {fmt(c.weight, 1)}
                <small>кг</small>
              </div>
            </div>
            <div>
              <div className="hero-cap">Жир</div>
              <div className="hero-num" style={{ color: 'var(--accent)' }}>
                {fmt(c.fatPct, 1)}
                <small>%</small>
              </div>
            </div>
            <div>
              <div className="hero-cap">Мышцы</div>
              <div className="hero-num" style={{ fontSize: 24 }}>
                {fmt(c.smm, 1)}
                <small>кг</small>
              </div>
            </div>
          </div>
          <div className="hero-right">
            <div className={`live-pill ${shown.mode === 'history' ? 'hist' : shown.mode === 'forecast' ? 'fc' : ''}`}>
              {shown.mode === 'live' ? <span className="live-dot" /> : shown.mode === 'history' ? <History size={12} /> : <TrendingDown size={12} />}
              {shown.mode === 'live' ? 'LIVE' : shown.mode === 'history' ? 'ИСТОРИЯ' : 'ПРОГНОЗ'}
            </div>
            {shown.mode === 'live' && Math.abs(fatG) >= 1 && (
              <div className={`badge ${fatG < 0 ? 'accent' : 'amber'}`}>
                {signed(fatG, 0)} г жира
              </div>
            )}
            {compare && <div className="badge amber">контур: {t === 0 ? 'старт' : 'сейчас'}</div>}
          </div>
          <div className="hero-tools">
            {(['front', 'side', 'back'] as const).map((v) => (
              <button key={v} className={view?.name === v ? 'on' : ''} onClick={() => setView({ name: v, nonce: Date.now() })}>
                {v === 'front' ? 'Спереди' : v === 'side' ? 'Сбоку' : 'Сзади'}
              </button>
            ))}
            <button className={view?.name === 'face' ? 'on' : ''} onClick={() => setView({ name: 'face', nonce: Date.now() })} aria-label="Лицо">
              <ScanFace size={16} />
            </button>
            <span className="sep" />
            <button className={rings ? 'on' : ''} onClick={() => setRings(!rings)} aria-label="Обхваты">
              <Ruler size={16} />
            </button>
            <button className={compare ? 'on' : ''} onClick={() => setCompare(!compare)} aria-label="Сравнить">
              <Ghost size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* time machine */}
      <div className="card">
        <div className="timeline-head">
          <div className="small muted bold" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Машина времени
          </div>
          <div className="timeline-date">
            {shown.label}
            {t !== 0 && (
              <button className="badge accent" style={{ marginLeft: 8 }} onClick={() => setT(0)}>
                сейчас
              </button>
            )}
          </div>
        </div>
        <input
          className="range"
          type="range"
          min={minT}
          max={FORECAST_DAYS}
          step={1}
          value={t}
          style={{ ['--now' as string]: `${nowFrac}%` }}
          onChange={(e) => {
            let v = Number(e.target.value);
            if (Math.abs(v) <= 2) v = 0;
            setT(v);
          }}
        />
        <div className="timeline-marks" style={{ position: 'relative', height: 14 }}>
          {minT < 0 && <span style={{ position: 'absolute', left: 0 }}>{first ? fmtDay(first.date) : ''}</span>}
          <span style={{ position: 'absolute', left: `${nowFrac}%`, transform: `translateX(${nowFrac < 12 ? '0' : nowFrac > 80 ? '-100%' : '-50%'})`, color: 'var(--text-2)' }}>сегодня</span>
          <span style={{ position: 'absolute', right: 0 }}>+12 нед</span>
        </div>
        {shown.mode === 'forecast' && pace && (
          <div className="small muted" style={{ marginTop: 8 }}>
            Темп {signed((pace.avg * 7) / KCAL_PER_KG_FAT, 2)} кг жира/нед ({pace.src}). Мышцы в прогнозе не меняются.
          </div>
        )}
      </div>

      {/* stats */}
      <div className="grid2">
        <Stat label="Вес" value={fmt(c.weight, 1)} unit="кг" delta={c.weight - anchor.weight} d={2} hint="с замера" invert />
        <Stat label="Жир" value={fmt(c.fatPct, 1)} unit="%" sub={cat.label} tone={cat.tone} />
        <Stat label="Масса жира" value={fmt(c.fatKg, 2)} unit="кг" delta={c.fatKg - anchor.fatKg} d={2} hint="с замера" invert />
        <Stat label="Скелетные мышцы" value={fmt(c.smm, 1)} unit="кг" delta={first ? c.smm - (first.smm ?? c.smm) : 0} d={1} hint="со старта" />
        <Stat label="Безжировая масса" value={fmt(c.ffm, 1)} unit="кг" />
        <Stat label="FFMI" value={fmt(ffmi(c.ffm, profile.heightCm), 1)} sub={ffmiLabel(ffmi(c.ffm, profile.heightCm), profile.sex)} />
        <Stat label="ИМТ" value={fmt(bmi(c.weight, profile.heightCm), 1)} sub="не учитывает мышцы" />
        {anchor.visceral !== undefined ? (
          <Stat label="Висцеральный жир" value={fmt(anchor.visceral, 0)} unit="ур." sub={anchor.visceral <= 9 ? 'норма' : 'повышен'} tone={anchor.visceral <= 9 ? 'good' : 'bad'} />
        ) : (
          <Stat label="Жира до цели" value={profile.targetFatPct ? fmt(Math.max(0, c.fatKg - (c.ffm * profile.targetFatPct) / (100 - profile.targetFatPct)), 1) : '—'} unit={profile.targetFatPct ? 'кг' : ''} sub={profile.targetFatPct ? `цель ${profile.targetFatPct}%` : 'цель не задана'} />
        )}
      </div>

      {/* energy */}
      <div className="section-label">Энергобаланс · 7700 ккал = 1 кг жира</div>
      <div className="card glow">
        <div className="row" style={{ gap: 16 }}>
          <Ring value={toNextKg} max={KCAL_PER_KG_FAT} size={118} stroke={10} color={live.balanceSinceAnchor <= 0 ? 'var(--accent)' : 'var(--amber)'}>
            <div className="big" style={{ fontSize: 22 }}>
              {signed(fatG / 1000, 2)}
            </div>
            <div className="cap">кг жира</div>
          </Ring>
          <div className="grow">
            <div className="small muted">С замера {fmtDateTime(anchor.date)}</div>
            <div className="bold num" style={{ fontSize: 20, margin: '4px 0' }}>
              {live.balanceSinceAnchor <= 0 ? 'Дефицит ' : 'Профицит '}
              {fmt(Math.abs(live.balanceSinceAnchor))} ккал
            </div>
            <div className="small muted">
              {fmt(toNextKg)} из 7700 ккал до {live.balanceSinceAnchor <= 0 ? 'следующего −1 кг' : 'следующего +1 кг'}
            </div>
          </div>
        </div>
        <div className="divider" />
        <div className="grid3">
          <MiniStat label="Съедено сегодня" value={fmt(todayBal?.intake ?? 0)} />
          <MiniStat label="Потрачено к этому часу" value={fmt(todayBal?.expenditure ?? 0)} />
          <MiniStat label="Баланс" value={todayBal?.logged ? signed(todayBal.balance) : '—'} tone={todayBal?.logged ? (todayBal.balance <= 0 ? 'pos' : 'neg') : ''} />
        </div>
        <div className="divider" />
        <div className="row between small">
          <span className="muted">
            {cap(monthName(today))}: {monthBal.logged} из {monthBal.total} дн. заполнено
          </span>
          <span className={`bold num ${monthBal.balance <= 0 ? 'pos' : 'neg'}`}>
            {signed(monthBal.balance)} ккал = {signed(monthBal.balance / KCAL_PER_KG_FAT, 2)} кг
          </span>
        </div>
        {live.missingDays > 0 && (
          <div className="note" style={{ marginTop: 12, marginBottom: 0 }}>
            <AlertTriangle size={16} />
            <div>
              {live.missingDays} дн. без записей еды с последнего замера — они не учитываются (считаются как поддержание), чтобы забытый дневник не выглядел как голодовка.
            </div>
          </div>
        )}
        {!todayBal?.logged && (
          <button className="btn sm block" style={{ marginTop: 12 }} onClick={() => onNavigate('food')}>
            <Plus size={16} /> Записать еду за сегодня
          </button>
        )}
      </div>

      {/* forecast */}
      {pace && (
        <div className="card">
          <div className="card-title">
            Прогноз <span className="badge">{pace.src}</span>
          </div>
          <div className="grid3">
            {[28, 56, 84].map((d) => {
              const f = forecast(live, pace.avg, d);
              return (
                <div key={d} className="col" style={{ alignItems: 'flex-start' }}>
                  <span className="tiny muted bold">через {d / 7} нед</span>
                  <span className="bold num" style={{ fontSize: 18 }}>
                    {fmt(f.weight, 1)} кг
                  </span>
                  <span className="small num" style={{ color: 'var(--accent)' }}>
                    {fmt(f.fatPct, 1)}% жира
                  </span>
                </div>
              );
            })}
          </div>
          <div className="row small muted" style={{ marginTop: 10, gap: 6 }}>
            {pace.avg <= 0 ? <TrendingDown size={14} /> : <TrendingUp size={14} />}
            {signed((pace.avg * 30) / KCAL_PER_KG_FAT, 2)} кг жира в месяц при текущем балансе {signed(pace.avg)} ккал/день
          </div>
        </div>
      )}

      {/* girths */}
      {girths.length > 0 && (
        <div className="card">
          <div className="card-title">
            Обхваты модели
            <button className="link" onClick={() => setAvatarOpen(true)}>
              ввести свои
            </button>
          </div>
          {girths.map((g) => {
            const r = startRatio?.[g.key];
            const d = r ? g.cm - g.cm * r : 0;
            return (
              <div className="kv" key={g.key}>
                <span className="k">{g.label}</span>
                <span className="v">
                  {fmt(g.cm, 1)} см {Math.abs(d) >= 0.1 && <span className={`small ${d < 0 ? 'pos' : 'neg'}`}>{signed(d, 1)}</span>}
                </span>
              </div>
            );
          })}
          <div className="row tiny muted" style={{ marginTop: 6, gap: 6 }}>
            <Info size={13} /> Сравнение со стартом. Сверяй с рулеткой раз в 2–4 недели.
          </div>
        </div>
      )}

      {/* last measurement */}
      <div className="card">
        <div className="card-title">
          Последний замер
          <button className="link" onClick={() => (setQr(null), setMOpen(true))}>
            + вручную
          </button>
        </div>
        <div className="row">
          <div className="food-img">{anchor.source === 'qr' ? <QrCode size={20} /> : <Flame size={20} />}</div>
          <div className="grow">
            <div className="bold">{fmtDateTime(anchor.date)}</div>
            <div className="small muted">
              {fmt(anchor.weight, 1)} кг · {fmt(anchor.fatPct, 1)}% жира{anchor.smm ? ` · ${fmt(anchor.smm, 1)} кг мышц` : ''} · {anchor.source === 'qr' ? 'QR' : 'вручную'}
            </div>
          </div>
        </div>
        <button className="btn primary block" style={{ marginTop: 14 }} onClick={startQr}>
          <QrCode size={18} /> Новый замер по QR
        </button>
      </div>

      <MeasurementSheet open={mOpen} onClose={() => setMOpen(false)} parsed={qr} />
      <AvatarSheet
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        live={live}
        girthsNow={Object.fromEntries(girths.map((g) => [g.key, g.cm]))}
        onPhotoFit={() => (setAvatarOpen(false), setPhotoOpen(true))}
        onFaceFit={() => (setAvatarOpen(false), setFaceOpen(true))}
      />
      <PhotoFitSheet open={photoOpen} onClose={() => setPhotoOpen(false)} live={live} />
      <FaceFitSheet open={faceOpen} onClose={() => setFaceOpen(false)} />
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ffmiLabel(v: number, sex: 'male' | 'female') {
  const t = sex === 'male' ? [18, 20, 22, 25] : [14, 16, 18, 21];
  if (v < t[0]) return 'ниже среднего';
  if (v < t[1]) return 'средний';
  if (v < t[2]) return 'выше среднего';
  if (v < t[3]) return 'атлетичный';
  return 'очень высокий';
}

function Stat({ label, value, unit, delta, d = 1, hint, sub, tone, invert }: { label: string; value: string; unit?: string; delta?: number; d?: number; hint?: string; sub?: string; tone?: string; invert?: boolean }) {
  const showDelta = delta !== undefined && Math.abs(delta) >= Math.pow(10, -d) / 2;
  const good = delta !== undefined && (invert ? delta < 0 : delta > 0);
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {showDelta ? (
        <div className={`delta ${good ? 'pos' : 'neg'}`}>
          {signed(delta!, d)} {hint}
        </div>
      ) : sub ? (
        <div className={`delta ${tone === 'good' ? 'pos' : tone === 'bad' ? 'bad' : 'muted'}`}>{sub}</div>
      ) : (
        <div className="delta muted">&nbsp;</div>
      )}
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="col">
      <span className="tiny muted bold" style={{ lineHeight: 1.25 }}>
        {label}
      </span>
      <span className={`bold num ${tone ?? ''}`} style={{ fontSize: 18 }}>
        {value}
      </span>
    </div>
  );
}
