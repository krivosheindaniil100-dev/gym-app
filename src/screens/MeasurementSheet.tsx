import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, QrCode } from 'lucide-react';
import { Chips, NumField, Sheet, toast, fmt } from '../ui/kit';
import { useApp } from '../lib/store';
import { completeFields, FIELD_LABEL, type MField, type QrParse } from '../lib/qr';
import { success } from '../lib/native';
import type { Measurement } from '../lib/types';
import { defaultSmm } from '../body/model';

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MAP_FIELDS: MField[] = ['weight', 'fatPct', 'fatKg', 'smm', 'ffm', 'water', 'visceral', 'bmr'];

function MeasurementBody({
  open,
  onClose,
  parsed,
  edit,
}: {
  open: boolean;
  onClose: () => void;
  parsed?: QrParse | null;
  edit?: Measurement | null;
}) {
  const add = useApp((s) => s.addMeasurement);
  const update = useApp((s) => s.updateMeasurement);
  const del = useApp((s) => s.deleteMeasurement);
  const learnQr = useApp((s) => s.learnQr);
  const sex = useApp((s) => s.profile.sex);
  // state is initialised synchronously from the props (the body is remounted for every opening)
  const [date, setDate] = useState(() => toLocalInput(edit ? edit.date : (parsed?.date ?? new Date().toISOString())));
  const [f, setF] = useState<Partial<Record<MField, number>>>(() => {
    if (edit) return { weight: edit.weight, fatPct: edit.fatPct, smm: edit.smm, visceral: edit.visceral, water: edit.water, bmr: edit.bmr };
    if (parsed) {
      const pf = { ...parsed.fields };
      if (pf.fatPct === undefined && pf.fatKg !== undefined && pf.weight) pf.fatPct = Math.round((pf.fatKg / pf.weight) * 1000) / 10;
      return pf;
    }
    return {};
  });
  const [mapping, setMapping] = useState<Partial<Record<MField, number>>>({});
  const [assignIdx, setAssignIdx] = useState<number | null>(null);
  const dateMs = new Date(date).getTime();
  const dateError = !date || Number.isNaN(dateMs) ? 'Укажи дату и время замера.' : dateMs > Date.now() + 5 * 60000 ? 'Замер не может быть из будущего.' : dateMs < new Date(2015, 0, 1).getTime() ? 'Слишком старая дата.' : null;

  const done = useMemo(() => completeFields(f), [f]);
  const needsMapping = parsed?.kind === 'numbers' && Object.keys(parsed.fields).length === 0;

  const save = () => {
    if (!done || dateError) return;
    const m: Omit<Measurement, 'id'> = {
      date: new Date(date).toISOString(),
      source: parsed ? 'qr' : edit?.source ?? 'manual',
      weight: round1(done.weight),
      fatPct: round1(done.fatPct),
      fatKg: round2(done.fatKg),
      ffm: round2(done.ffm),
      smm: done.smm !== undefined ? round1(done.smm) : round1(defaultSmm(sex, done.ffm)),
      water: done.water,
      visceral: done.visceral,
      bmr: done.bmr,
      raw: parsed?.raw ?? edit?.raw,
    };
    if (parsed && Object.keys(mapping).length) learnQr(parsed.signature, mapping);
    if (edit) update(edit.id, m);
    else add(m);
    success();
    toast(edit ? 'Замер обновлён' : 'Замер добавлен — модель пересчитана');
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      full
      title={edit ? 'Замер' : parsed ? 'Данные из QR' : 'Новый замер'}
      footer={
        <div className="row">
          {edit && (
            <button
              className="btn danger"
              onClick={() => {
                if (confirm('Удалить этот замер?')) {
                  del(edit.id);
                  onClose();
                }
              }}
            >
              Удалить
            </button>
          )}
          <button className="btn primary grow" disabled={!done || !!dateError} onClick={save}>
            Сохранить
          </button>
        </div>
      }
    >
      {parsed && (
        <div className="card" style={{ padding: 12 }}>
          <div className="row small">
            <QrCode size={16} className="muted" />
            <span className="muted">
              Формат: <b style={{ color: 'var(--text)' }}>{{ json: 'JSON', url: 'ссылка', kv: 'ключ=значение', numbers: 'набор чисел', unknown: 'неизвестный' }[parsed.kind]}</b>
              {parsed.host ? ` · ${parsed.host}` : ''}
            </span>
          </div>
          <div className="tiny muted" style={{ marginTop: 6, wordBreak: 'break-all', maxHeight: 54, overflow: 'hidden' }}>
            {parsed.raw}
          </div>
        </div>
      )}
      {parsed?.linkOnly && (
        <div className="note">
          <AlertTriangle size={18} />
          <div>
            QR содержит только ссылку на облачный сервис весов — самих цифр в коде нет. Перепишите значения с экрана или бланка (вес, % жира, мышцы) — это займёт 10 секунд.
            <div style={{ marginTop: 8 }}>
              <a href={parsed.raw} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                Открыть ссылку <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>
      )}
      {needsMapping && (
        <div className="card">
          <div className="card-title">Сопоставьте числа из кода</div>
          <p className="p" style={{ marginTop: -4 }}>
            Нажмите на число и выберите, что оно означает. Приложение запомнит формат ваших весов, и в следующий раз всё заполнится само.
          </p>
          <div className="chips">
            {parsed!.numbers.map((n, i) => {
              const fld = (Object.entries(mapping) as [MField, number][]).find(([, idx]) => idx === i)?.[0];
              return (
                <button key={i} className={`chip ${assignIdx === i ? 'on' : ''}`} onClick={() => setAssignIdx(i)}>
                  <span className="num">{n}</span>
                  {fld && <span className="badge accent">{FIELD_LABEL[fld].split(',')[0]}</span>}
                </button>
              );
            })}
          </div>
          {assignIdx !== null && (
            <div style={{ marginTop: 12 }}>
              <div className="small muted" style={{ marginBottom: 8 }}>
                Число {parsed!.numbers[assignIdx]} — это:
              </div>
              <Chips
                value={'' as string}
                options={MAP_FIELDS.map((k) => ({ v: k, l: FIELD_LABEL[k] }))}
                onChange={(k: MField) => {
                  const nm = { ...mapping };
                  for (const kk of Object.keys(nm) as MField[]) if (nm[kk] === assignIdx) delete nm[kk];
                  nm[k] = assignIdx;
                  setMapping(nm);
                  setF((prev) => ({ ...prev, [k]: parsed!.numbers[assignIdx] }));
                  setAssignIdx(null);
                }}
              />
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label>Дата и время замера</label>
        <input className="input" type="datetime-local" value={date} max={toLocalInput(new Date().toISOString())} onChange={(e) => setDate(e.target.value)} />
        {dateError && <span className="small bad">{dateError}</span>}
      </div>
      <div className="grid2">
        <div className="field">
          <label>Вес</label>
          <NumField value={f.weight} onChange={(v) => setF({ ...f, weight: v })} suffix="кг" placeholder="80,5" />
        </div>
        <div className="field">
          <label>Жир</label>
          <NumField value={f.fatPct} onChange={(v) => setF({ ...f, fatPct: v, fatKg: undefined })} suffix="%" placeholder="18,5" />
        </div>
        <div className="field">
          <label>Скелетные мышцы</label>
          <NumField value={f.smm} onChange={(v) => setF({ ...f, smm: v })} suffix="кг" placeholder="авто" />
        </div>
        <div className="field">
          <label>Висцеральный жир</label>
          <NumField value={f.visceral} onChange={(v) => setF({ ...f, visceral: v })} suffix="ур." placeholder="—" />
        </div>
        <div className="field">
          <label>Вода</label>
          <NumField value={f.water} onChange={(v) => setF({ ...f, water: v })} suffix="кг" placeholder="—" />
        </div>
        <div className="field">
          <label>Обмен (с весов)</label>
          <NumField value={f.bmr} onChange={(v) => setF({ ...f, bmr: v })} suffix="ккал" placeholder="—" />
        </div>
      </div>
      {done ? (
        <div className="card glow">
          <div className="kv">
            <span className="k">Масса жира</span>
            <span className="v">{fmt(done.fatKg, 1)} кг</span>
          </div>
          <div className="kv">
            <span className="k">Безжировая масса</span>
            <span className="v">{fmt(done.ffm, 1)} кг</span>
          </div>
          <div className="kv">
            <span className="k">Скелетные мышцы</span>
            <span className="v">
              {fmt(done.smm ?? defaultSmm(sex, done.ffm), 1)} кг {done.smm === undefined && <span className="badge">оценка</span>}
            </span>
          </div>
        </div>
      ) : (
        <p className="small muted">Минимум: вес и процент жира. Мышцы можно не указывать — оценим по безжировой массе.</p>
      )}
    </Sheet>
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

export default function MeasurementSheet(props: { open: boolean; onClose: () => void; parsed?: QrParse | null; edit?: Measurement | null }) {
  const n = useRef(0);
  const was = useRef(false);
  if (props.open && !was.current) n.current++;
  was.current = props.open;
  if (!props.open) return null;
  return <MeasurementBody key={n.current} {...props} />;
}
