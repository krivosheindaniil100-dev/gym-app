import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useApp } from '../lib/store';
import { Sheet, fmt, toast } from '../ui/kit';
import { detectPose, fileToCanvas, type PoseResult } from '../human/vision';
import { girthsFromPhotos, measureFront, measureSide, type Level, type SideMeasure } from '../human/photoMeasure';
import { avatarOf, FAT_SHARE } from '../human/avatar';
import { GIRTH_LABEL, type GirthKey } from '../human/fit';
import type { Composition } from '../lib/energy';
import type { AvatarSettings } from '../lib/types';
import { success } from '../lib/native';

type Shot = { canvas: HTMLCanvasElement; pose: PoseResult | null; m: SideMeasure | null };

export default function PhotoFitSheet({ open, onClose, live }: { open: boolean; onClose: () => void; live: Composition }) {
  const profile = useApp((s) => s.profile);
  const setProfile = useApp((s) => s.setProfile);
  const [front, setFront] = useState<Shot | null>(null);
  const [side, setSide] = useState<Shot | null>(null);
  const [busy, setBusy] = useState<'front' | 'side' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFront(null);
      setSide(null);
      setErr(null);
    }
  }, [open]);

  const handle = async (which: 'front' | 'side', f: File | undefined) => {
    if (!f) return;
    setBusy(which);
    setErr(null);
    try {
      const canvas = await fileToCanvas(f, 1400);
      const pose = await detectPose(canvas);
      if (!pose) throw new Error('Человек на фото не найден. Нужен рост целиком, хорошее освещение.');
      const m = which === 'front' ? measureFront(pose, profile.heightCm) : measureSide(pose, profile.heightCm, front?.m?.fracWaist);
      if (m.error) setErr(m.error);
      (which === 'front' ? setFront : setSide)({ canvas, pose, m });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
    setBusy(null);
  };

  // re-measure side when front (waist level) appears later
  useEffect(() => {
    if (side?.pose && front?.m?.fracWaist) setSide({ ...side, m: measureSide(side.pose, profile.heightCm, front.m.fracWaist) });
  }, [front?.m?.fracWaist]);

  const girths = front?.m && !front.m.error ? girthsFromPhotos(front.m, side?.m && !side.m.error ? side.m : null) : {};
  const a = avatarOf(profile);

  const apply = () => {
    const g: AvatarSettings['girths'] = { ...a.girths };
    let n = 0;
    for (const [k, cm] of Object.entries(girths) as [Level, number][]) {
      if (g[k as GirthKey]?.source === 'tape') continue; // tape is more accurate
      g[k as GirthKey] = { cm, fatKg: live.fatKg, fatShare: FAT_SHARE[k], source: 'photo', date: new Date().toISOString() };
      n++;
    }
    setProfile({ avatar: { ...a, girths: g } });
    success();
    toast(n ? `Модель подогнана по фото: ${n} обхватов` : 'Замеры рулеткой уже точнее — оставлены они');
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      full
      title="Подгонка по фото"
      footer={
        <button className="btn primary block" disabled={!Object.keys(girths).length} onClick={apply}>
          <CheckCircle2 size={18} /> Применить к модели
        </button>
      }
    >
      <p className="p" style={{ marginTop: 0 }}>
        Нужны 2 фото в облегающей одежде или белье, телефон на уровне пояса, 2,5–3 м до тебя, всё тело в кадре, однотонный фон. Рост ({profile.heightCm} см)
        задаёт масштаб. Всё считается на телефоне, фото никуда не отправляются.
      </p>
      <ShotCard
        title="1. Спереди"
        hint="Стопы на ширине плеч, руки в стороны на 30–45° (не касаются тела)."
        shot={front}
        busy={busy === 'front'}
        onFile={(f) => handle('front', f)}
      />
      <ShotCard title="2. Сбоку" hint="Повернись боком, руки расслаблены вдоль тела, смотри прямо." shot={side} busy={busy === 'side'} onFile={(f) => handle('side', f)} />
      {err && (
        <div className="note">
          <AlertTriangle size={16} />
          <div>{err}</div>
        </div>
      )}
      {Object.keys(girths).length > 0 && (
        <div className="card glow">
          <div className="card-title">Обхваты по фото</div>
          {(Object.entries(girths) as [Level, number][]).map(([k, cm]) => (
            <div className="kv" key={k}>
              <span className="k">{GIRTH_LABEL[k as GirthKey]}</span>
              <span className="v">
                {fmt(cm, 1)} см {a.girths[k as GirthKey]?.source === 'tape' && <span className="badge">есть рулетка</span>}
              </span>
            </div>
          ))}
          <div className="tiny muted" style={{ marginTop: 6 }}>
            Точность по фото ±2–4 см (зависит от позы и одежды). Рулетка точнее — её значения не перезаписываются.
          </div>
        </div>
      )}
    </Sheet>
  );
}

function ShotCard({ title, hint, shot, busy, onFile }: { title: string; hint: string; shot: Shot | null; busy: boolean; onFile: (f: File | undefined) => void }) {
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!shot || !cv.current) return;
    const c = cv.current;
    const W = 300;
    const s = W / shot.canvas.width;
    c.width = W;
    c.height = Math.round(shot.canvas.height * s);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(shot.canvas, 0, 0, c.width, c.height);
    if (shot.pose) {
      // tint the body mask
      const p = shot.pose;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const mx = Math.floor((x / c.width) * p.w);
          const my = Math.floor((y / c.height) * p.h);
          if (p.mask[my * p.w + mx] > 0.5) {
            const i = (y * c.width + x) * 4;
            img.data[i] = img.data[i] * 0.6 + 124 * 0.4;
            img.data[i + 1] = img.data[i + 1] * 0.6 + 247 * 0.4;
            img.data[i + 2] = img.data[i + 2] * 0.6 + 200 * 0.4;
          }
        }
      ctx.putImageData(img, 0, 0);
      const ms = c.width / p.w;
      ctx.strokeStyle = '#ffb547';
      ctx.lineWidth = 2;
      for (const l of shot.m?.lines ?? []) {
        ctx.beginPath();
        ctx.moveTo(l.x0 * ms, l.y0 * ms);
        ctx.lineTo(l.x1 * ms, l.y1 * ms);
        ctx.stroke();
      }
    }
  }, [shot]);
  return (
    <div className="card">
      <div className="bold">{title}</div>
      <div className="small muted" style={{ margin: '3px 0 10px' }}>
        {hint}
      </div>
      {shot && <canvas ref={cv} style={{ width: '100%', borderRadius: 14, marginBottom: 10 }} />}
      <div className="grid2">
        <button className="btn sm" onClick={() => camRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Camera size={16} />} Снять
        </button>
        <button className="btn sm" onClick={() => galRef.current?.click()} disabled={busy}>
          <ImageIcon size={16} /> Из галереи
        </button>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      <input ref={galRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
    </div>
  );
}
