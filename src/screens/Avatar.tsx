import { useEffect, useState } from 'react';
import { Camera, Info, Ruler, ScanFace, Sparkles } from 'lucide-react';
import { useApp } from '../lib/store';
import { NumField, Seg, Sheet, fmt, toast } from '../ui/kit';
import { avatarOf, BODY_SHAPES, BROW_OPTIONS, EYE_OPTIONS, FAT_SHARE, HAIR_COLORS, HAIR_STYLES, SKIN_TONES, ZONES } from '../human/avatar';
import { eyeKey } from '../human/HumanViewer';
import { Chips } from '../ui/kit';
import { GIRTH_KEYS, GIRTH_LABEL, type GirthKey } from '../human/fit';
import type { AvatarSettings } from '../lib/types';
import type { Composition } from '../lib/energy';
import { success } from '../lib/native';

const HOW_TO: Record<GirthKey, string> = {
  neck: 'под кадыком, лента горизонтально',
  chest: 'по самой выступающей точке груди, под мышками',
  waist: 'самое узкое место между рёбрами и тазом, на выдохе',
  hips: 'по самым выступающим точкам ягодиц',
  thigh: 'на 2–3 см ниже ягодичной складки',
  calf: 'самое широкое место голени',
  arm: 'середина плеча, рука расслаблена',
};

export default function AvatarSheet({
  open,
  onClose,
  live,
  girthsNow,
  onPhotoFit,
  onFaceFit,
}: {
  open: boolean;
  onClose: () => void;
  live: Composition;
  girthsNow: Record<string, number>;
  onPhotoFit: () => void;
  onFaceFit: () => void;
}) {
  const profile = useApp((s) => s.profile);
  const setProfile = useApp((s) => s.setProfile);
  const a = avatarOf(profile);
  const set = (x: Partial<AvatarSettings>) => setProfile({ avatar: { ...a, ...x } });
  const [tab, setTab] = useState<'shape' | 'tape' | 'look'>('shape');
  const [tape, setTape] = useState<Partial<Record<GirthKey, number>>>({});
  useEffect(() => {
    if (open) setTape(Object.fromEntries(GIRTH_KEYS.map((k) => [k, a.girths[k]?.cm])) as Partial<Record<GirthKey, number>>);
  }, [open]);

  const shapes = BODY_SHAPES[profile.sex];
  const curShape = Object.keys(a.shape)[0] ?? '';

  return (
    <Sheet open={open} onClose={onClose} title="Мой аватар" half>
      <div className="grid2" style={{ marginBottom: 12 }}>
        <button className="btn sm" onClick={onPhotoFit}>
          <Camera size={16} /> По фото
        </button>
        <button className="btn sm" onClick={onFaceFit}>
          <ScanFace size={16} /> Лицо по селфи
        </button>
      </div>
      <Seg
        value={tab}
        options={[
          { v: 'shape', l: 'Телосложение' },
          { v: 'tape', l: 'Замеры' },
          { v: 'look', l: 'Внешность' },
        ]}
        onChange={setTab}
      />

      {tab === 'shape' && (
        <>
          <div className="section-label">Где у тебя больше всего жира</div>
          <p className="p" style={{ marginTop: -4 }}>
            Модель распределит жир так же, и при похудении он будет уходить в первую очередь оттуда, где его больше.
          </p>
          {ZONES.map((z) => {
            const v = a.pattern[z.key] ?? 1;
            const val = v < 0.9 ? 'less' : v > 1.15 ? (v > 1.6 ? 'most' : 'more') : 'avg';
            return (
              <div className="row between" key={z.key} style={{ marginBottom: 8 }}>
                <span className="bold" style={{ width: 104, flex: 'none', fontSize: 14 }}>
                  {z.label}
                </span>
                <div className="grow">
                  <Seg
                    value={val}
                    options={[
                      { v: 'less', l: 'мало' },
                      { v: 'avg', l: 'обычно' },
                      { v: 'more', l: 'больше' },
                      { v: 'most', l: 'много' },
                    ]}
                    onChange={(x) => {
                      const m = x === 'less' ? 0.65 : x === 'more' ? 1.45 : x === 'most' ? 1.9 : 1;
                      const p = { ...a.pattern };
                      if (m === 1) delete p[z.key];
                      else p[z.key] = m;
                      set({ pattern: p });
                    }}
                  />
                </div>
              </div>
            );
          })}
          <div className="section-label">Тип фигуры</div>
          {shapes.map((s) => (
            <button
              key={s.key}
              className={`pick ${curShape === s.key ? 'on' : ''}`}
              onClick={() => set({ shape: curShape === s.key ? {} : { [s.key]: 0.55 } })}
            >
              <div className="grow">
                <div className="pt">{s.label}</div>
                <div className="pd">{s.hint}</div>
              </div>
            </button>
          ))}
        </>
      )}

      {tab === 'tape' && (
        <>
          <div className="note info" style={{ marginTop: 12 }}>
            <Ruler size={16} />
            <div>
              Самый точный способ сделать модель «тобой». Измерь сантиметровой лентой — модель подстроится под эти цифры и дальше будет меняться от них по
              калориям. Жировая часть обхвата уменьшается при похудении, костная/мышечная — нет.
            </div>
          </div>
          {GIRTH_KEYS.map((k) => (
            <div className="field" key={k}>
              <label>
                {GIRTH_LABEL[k]} — <span className="muted">{HOW_TO[k]}</span>
              </label>
              <NumField value={tape[k]} onChange={(v) => setTape({ ...tape, [k]: v })} suffix="см" placeholder={girthsNow[k] ? `модель: ${fmt(girthsNow[k], 1)}` : ''} />
              {a.girths[k] && (
                <span className="tiny muted">
                  сохранено {a.girths[k]!.source === 'photo' ? 'по фото' : 'рулеткой'} {new Date(a.girths[k]!.date).toLocaleDateString('ru-RU')} при {fmt(a.girths[k]!.fatKg, 1)} кг жира
                </span>
              )}
            </div>
          ))}
          <div className="grid2">
            <button
              className="btn"
              onClick={() => {
                set({ girths: {} });
                setTape({});
                toast('Замеры сброшены');
              }}
            >
              Сбросить
            </button>
            <button
              className="btn primary"
              onClick={() => {
                const g: AvatarSettings['girths'] = { ...a.girths };
                for (const k of GIRTH_KEYS) {
                  const v = tape[k];
                  if (v && v > 15 && v < 250) g[k] = { cm: v, fatKg: live.fatKg, fatShare: FAT_SHARE[k], source: 'tape', date: new Date().toISOString() };
                  else delete g[k];
                }
                set({ girths: g });
                success();
                toast('Модель подогнана под твои замеры');
              }}
            >
              Применить
            </button>
          </div>
        </>
      )}

      {tab === 'look' && (
        <>
          <div className="section-label">Тон кожи</div>
          <Swatches value={a.skinTone} options={SKIN_TONES} onChange={(v) => set({ skinTone: v })} />
          <div className="section-label">Глаза</div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {EYE_OPTIONS.map((e) => (
              <button
                key={e.v}
                onClick={() => set({ eyeColor: e.v })}
                aria-label={e.l}
                title={e.l}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: '50%',
                  background: `radial-gradient(circle, #0b0705 0 26%, ${e.c} 28% 62%, #e9e4de 64%)`,
                  border: eyeKey(a.eyeColor) === e.v ? '2px solid var(--accent)' : '1px solid var(--border-2)',
                  boxShadow: eyeKey(a.eyeColor) === e.v ? '0 0 0 3px rgba(124,247,200,.25)' : 'none',
                }}
              />
            ))}
          </div>
          <div className="section-label">Причёска</div>
          <Chips value={a.hairStyle === 'short' ? 'short02' : a.hairStyle} options={HAIR_STYLES} onChange={(v: string) => set({ hairStyle: v })} />
          <div className="section-label">Цвет волос</div>
          <Swatches value={a.hairColor} options={HAIR_COLORS} onChange={(v) => set({ hairColor: v })} />
          <div className="section-label">Брови</div>
          <Seg value={a.brows ?? ''} options={BROW_OPTIONS} onChange={(v) => set({ brows: v || null })} />
          <div className="section-label">Черты лица</div>
          <Seg
            value={a.ethnic.caucasian > 0.6 ? 'eu' : a.ethnic.asian > 0.6 ? 'as' : a.ethnic.african > 0.6 ? 'af' : 'mix'}
            options={[
              { v: 'eu', l: 'Европ.' },
              { v: 'as', l: 'Азиат.' },
              { v: 'af', l: 'Африк.' },
              { v: 'mix', l: 'Смешан.' },
            ]}
            onChange={(v) =>
              set({
                ethnic:
                  v === 'eu'
                    ? { african: 0.05, asian: 0.1, caucasian: 0.85 }
                    : v === 'as'
                      ? { african: 0.05, asian: 0.85, caucasian: 0.1 }
                      : v === 'af'
                        ? { african: 0.85, asian: 0.05, caucasian: 0.1 }
                        : { african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 },
              })
            }
          />
          <div className="row tiny muted" style={{ marginTop: 12, gap: 6 }}>
            <Info size={13} /> Для максимального сходства лица используй «Лицо по селфи».
          </div>
        </>
      )}
      <div className="row tiny muted" style={{ marginTop: 14, gap: 6 }}>
        <Sparkles size={13} /> Модель: анатомическая сетка MakeHuman (CC0), форма считается из твоего состава тела.
      </div>
    </Sheet>
  );
}

function Swatches({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
      {options.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          aria-label={c}
          style={{
            width: 38,
            height: 38,
            borderRadius: 12,
            background: c,
            border: value === c ? '2px solid var(--accent)' : '1px solid var(--border-2)',
            boxShadow: value === c ? '0 0 0 3px rgba(124,247,200,.25)' : 'none',
          }}
        />
      ))}
      <label style={{ width: 38, height: 38, borderRadius: 12, border: '1px dashed var(--border-2)', display: 'grid', placeItems: 'center', position: 'relative', overflow: 'hidden' }}>
        <span className="tiny muted">+</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0 }} />
      </label>
    </div>
  );
}
