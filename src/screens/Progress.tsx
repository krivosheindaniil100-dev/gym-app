import { useMemo, useState } from 'react';
import { ChevronRight, Plus, QrCode, Settings as Gear, Pencil } from 'lucide-react';
import { useBias, useLedgerInput, useNow } from '../lib/hooks';
import { calibrations, dailyBalances, KCAL_PER_KG_FAT, liveState, monthSummaries, sortedMeasurements } from '../lib/energy';
import { addDays, dayKey, fmtDateTime, fmtDay, fromKey } from '../lib/date';
import { BalanceBars, CHART, LineChart, type LinePoint } from '../ui/charts';
import { Seg, fmt, signed } from '../ui/kit';
import MeasurementSheet from './MeasurementSheet';
import SettingsSheet from './Settings';
import type { Measurement } from '../lib/types';

type Metric = 'weight' | 'fatPct' | 'fatKg' | 'smm';
const METRIC: Record<Metric, { label: string; unit: string; d: number }> = {
  weight: { label: 'Вес', unit: 'кг', d: 1 },
  fatPct: { label: '% жира', unit: '%', d: 1 },
  fatKg: { label: 'Жир, кг', unit: 'кг', d: 2 },
  smm: { label: 'Мышцы', unit: 'кг', d: 1 },
};

export default function ProgressScreen({ active }: { active: boolean }) {
  const now = useNow(60000);
  const input = useLedgerInput();
  const bias = useBias();
  const [range, setRange] = useState<30 | 90 | 0>(30);
  const [metric, setMetric] = useState<Metric>('weight');
  const [edit, setEdit] = useState<Measurement | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const ms = useMemo(() => sortedMeasurements(input.measurements), [input.measurements]);
  const first = ms[0];
  const today = dayKey(now);
  const startKey = useMemo(() => {
    const fk = first ? dayKey(first.date) : today;
    if (range === 0) return fk;
    const r = addDays(today, -range + 1);
    return r < fk ? fk : r;
  }, [range, first?.id, today]);

  const series: LinePoint[] = useMemo(() => {
    const pts: LinePoint[] = [];
    if (metric === 'smm') {
      for (const m of ms) if (dayKey(m.date) >= startKey) pts.push({ x: new Date(m.date).getTime(), y: m.smm ?? m.ffm * 0.56, measured: true });
      return pts;
    }
    for (let k = startKey; k <= today; k = addDays(k, 1)) {
      const end = k === today ? now : new Date(fromKey(k).getTime() + 86399000);
      // measurements that day → exact points
      for (const m of ms) if (dayKey(m.date) === k) pts.push({ x: new Date(m.date).getTime(), y: m[metric], measured: true });
      const st = liveState(input, end, bias);
      if (st) pts.push({ x: end.getTime(), y: metric === 'weight' ? st.weight : metric === 'fatPct' ? st.fatPct : st.fatKg });
    }
    return pts.sort((a, b) => a.x - b.x);
  }, [metric, startKey, today, input, bias, ms, now.getTime()]);

  const balances = useMemo(() => dailyBalances(input, addDays(today, -29) < (first ? dayKey(first.date) : today) ? dayKey(first!.date) : addDays(today, -29), today, bias), [input, today, bias, first?.id]);
  const months = useMemo(() => (first ? monthSummaries(dailyBalances(input, dayKey(first.date), today, bias)) : []), [input, today, bias, first?.id]);
  const cals = useMemo(() => calibrations(input), [input]);
  const totalLogged = balances.filter((d) => d.logged);
  const sum30 = totalLogged.reduce((s, d) => s + d.balance, 0);

  const firstV = series[0]?.y;
  const lastV = series[series.length - 1]?.y;

  return (
    <div className={`screen ${active ? 'screen-enter' : ''}`}>
      <div className="topbar">
        <div>
          <h1>Прогресс</h1>
          <div className="sub">{first ? `с ${fmtDay(first.date, true)} · ${ms.length} замер(ов)` : ''}</div>
        </div>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Настройки">
          <Gear size={20} />
        </button>
      </div>

      <div className="card">
        <div style={{ marginBottom: 12 }}>
          <Seg value={metric} options={(Object.keys(METRIC) as Metric[]).map((m) => ({ v: m, l: METRIC[m].label }))} onChange={setMetric} />
        </div>
        <div className="row between" style={{ marginBottom: 6 }}>
          <div>
            <span className="bold num" style={{ fontSize: 26 }}>
              {lastV !== undefined ? fmt(lastV, METRIC[metric].d) : '—'}
            </span>
            <span className="muted"> {METRIC[metric].unit}</span>
          </div>
          {firstV !== undefined && lastV !== undefined && (
            <span className={`badge ${(metric === 'smm' ? lastV >= firstV : lastV <= firstV) ? 'accent' : 'amber'}`}>
              {signed(lastV - firstV, METRIC[metric].d)} {METRIC[metric].unit} за период
            </span>
          )}
        </div>
        <LineChart points={series} unit={METRIC[metric].unit} digits={METRIC[metric].d} />
        <div className="legend">
          <span>
            <svg width="22" height="10">
              <line x1="0" x2="22" y1="5" y2="5" stroke={CHART.line} strokeWidth="2" />
            </svg>
            расчёт по калориям (7700)
          </span>
          <span>
            <svg width="10" height="10">
              <circle cx="5" cy="5" r="4" fill={CHART.line} />
            </svg>
            замер на весах
          </span>
        </div>
        <div style={{ marginTop: 12 }}>
          <Seg
            value={range}
            options={[
              { v: 30, l: '30 дней' },
              { v: 90, l: '90 дней' },
              { v: 0, l: 'Всё время' },
            ]}
            onChange={setRange}
          />
        </div>
      </div>

      <div className="section-label">Калорийный баланс · 30 дней</div>
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <span className={`bold num ${sum30 <= 0 ? 'pos' : 'neg'}`} style={{ fontSize: 22 }}>
              {signed(sum30)} ккал
            </span>
            <div className="small muted">
              = {signed(sum30 / KCAL_PER_KG_FAT, 2)} кг жира · {totalLogged.length} из {balances.length} дн. заполнено
            </div>
          </div>
        </div>
        <BalanceBars data={balances.map((d) => ({ key: d.key, label: fmtDay(d.key), v: d.logged ? d.balance : null }))} />
        <div className="legend">
          <span>
            <span className="dot" style={{ background: CHART.deficit, borderRadius: 2 }} /> дефицит
          </span>
          <span>
            <span className="dot" style={{ background: CHART.surplus, borderRadius: 2 }} /> профицит
          </span>
          <span className="muted">· нажми на столбик</span>
        </div>
      </div>

      {months.length > 0 && (
        <>
          <div className="section-label">Итоги по месяцам</div>
          <div className="card">
            <div className="kv tiny muted bold" style={{ paddingTop: 0 }}>
              <span>Месяц</span>
              <span>Баланс → жир</span>
            </div>
            {[...months].reverse().map((m) => (
              <div className="kv" key={m.month}>
                <span className="k">
                  {new Date(m.month + '-01T12:00:00').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
                  <div className="tiny muted">
                    {m.loggedDays}/{m.totalDays} дн. с записями
                  </div>
                </span>
                <span className="v">
                  <span className={m.balance <= 0 ? 'pos' : 'neg'}>{signed(m.balance)} ккал</span>
                  <div className="small">{signed(m.fatKg, 2)} кг жира</div>
                </span>
              </div>
            ))}
            <div className="tiny muted" style={{ marginTop: 6 }}>
              Строго: каждые 7700 ккал дефицита = −1 кг жира.
            </div>
          </div>
        </>
      )}

      {cals.length > 0 && (
        <>
          <div className="section-label">Модель vs весы</div>
          <div className="card">
            {cals.slice(-3).reverse().map((c, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="small muted">
                  {fmtDay(c.from.date)} → {fmtDay(c.to.date)} ({Math.round(c.days)} дн., {Math.round(c.coverage * 100)}% дней заполнено)
                </div>
                <div className="row between">
                  <span>
                    Калории обещали <b>{signed(c.predictedFat, 2)} кг</b>, весы показали <b>{signed(c.actualFat, 2)} кг</b>
                  </span>
                </div>
                <div className="small" style={{ color: 'var(--accent)' }}>
                  Реальный расход ≈ на {fmt(Math.abs(c.biasPerDay))} ккал/день {c.biasPerDay >= 0 ? 'выше' : 'ниже'} расчётного
                </div>
              </div>
            ))}
            <div className="tiny muted">Биоимпеданс даёт погрешность ±1–1,5 кг жира, поэтому смотри на тенденцию по нескольким замерам. Автокоррекцию можно включить в настройках.</div>
          </div>
        </>
      )}

      <div className="section-label">Замеры</div>
      <div className="card">
        <div className="list">
          {[...ms].reverse().map((m, i, arr) => {
            const prev = arr[i + 1];
            return (
              <div className="item" key={m.id} onClick={() => setEdit(m)} role="button">
                <div className="food-img">{m.source === 'qr' ? <QrCode size={18} /> : <Pencil size={16} />}</div>
                <div className="grow">
                  <div className="title">{fmtDateTime(m.date)}</div>
                  <div className="meta">
                    {fmt(m.weight, 1)} кг · {fmt(m.fatPct, 1)}% · мышцы {fmt(m.smm ?? 0, 1)} кг
                  </div>
                </div>
                <div className="right">
                  {prev && (
                    <div className={`small bold num ${m.fatKg <= prev.fatKg ? 'pos' : 'neg'}`}>
                      {signed(m.fatKg - prev.fatKg, 1)} кг жира
                    </div>
                  )}
                </div>
                <ChevronRight size={16} className="muted" />
              </div>
            );
          })}
        </div>
        <button className="add-line" onClick={() => setAddOpen(true)}>
          <Plus size={18} /> Добавить замер вручную
        </button>
      </div>

      <MeasurementSheet open={!!edit} edit={edit} onClose={() => setEdit(null)} />
      <MeasurementSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
