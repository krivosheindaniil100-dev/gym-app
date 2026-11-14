import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react';
import { useApp } from '../lib/store';
import { Sheet, toast } from '../ui/kit';
import { fileToCanvas, getFace } from '../human/vision';
import { FACE_CORR, faceRatios, RATIO_LABEL } from '../human/face';
import { avatarOf, humanInputFor } from '../human/avatar';
import { useLive, useNow } from '../lib/hooks';
import HumanWorker from '../human/human.worker?worker';
import type { HumanRes } from '../human/human.worker';
import { success } from '../lib/native';

interface FaceData {
  crop: string; // dataURL 512²
  lm: number[]; // [mp, u, v] for FACE_CORR
  ratios: number[];
  skin: string;
  eye: string;
  hair: string | null;
  mods?: Record<string, number>;
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function avgColor(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const d = ctx.getImageData(Math.max(0, Math.round(x - r)), Math.max(0, Math.round(y - r)), Math.round(r * 2), Math.round(r * 2)).data;
  let R = 0,
    G = 0,
    B = 0,
    n = 0;
  for (let i = 0; i < d.length; i += 4) {
    R += d[i];
    G += d[i + 1];
    B += d[i + 2];
    n++;
  }
  return [R / n, G / n, B / n];
}

export default function FaceFitSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const profile = useApp((s) => s.profile);
  const setProfile = useApp((s) => s.setProfile);
  const now = useNow(60000);
  const live = useLive(now);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [face, setFace] = useState<FaceData | null>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const a = avatarOf(profile);

  useEffect(() => {
    if (open) {
      setFace(null);
      setErr(null);
    }
  }, [open]);

  const handle = async (f: File | undefined) => {
    if (!f || !live) return;
    setBusy(true);
    setErr(null);
    try {
      const canvas = await fileToCanvas(f, 1600);
      const fl = await getFace();
      const r = fl.detect(canvas);
      const lm = r.faceLandmarks?.[0];
      if (!lm) throw new Error('Лицо не найдено. Сделай селфи анфас при хорошем свете.');
      const px = (i: number): [number, number] => [lm[i].x * canvas.width, lm[i].y * canvas.height];
      const FW = Math.hypot(px(234)[0] - px(454)[0], px(234)[1] - px(454)[1]);
      const yaw = Math.abs(Math.hypot(px(1)[0] - px(234)[0], px(1)[1] - px(234)[1]) - Math.hypot(px(1)[0] - px(454)[0], px(1)[1] - px(454)[1])) / FW;
      if (yaw > 0.18) throw new Error('Голова повёрнута — смотри прямо в камеру.');
      const FH = Math.hypot(px(10)[0] - px(152)[0], px(10)[1] - px(152)[1]);
      const mouthOpen = Math.hypot(px(13)[0] - px(14)[0], px(13)[1] - px(14)[1]) / FH;
      const mouthW = Math.hypot(px(61)[0] - px(291)[0], px(61)[1] - px(291)[1]) / FW;
      if ((mouthOpen > 0.035 || mouthW > 0.5) && !(import.meta.env.DEV && location.search.includes('facetest'))) throw new Error('Нужно нейтральное лицо: рот закрыт, без улыбки — иначе модель получит чужую мимику.');
      // square crop around the face oval
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of lm) {
        minX = Math.min(minX, p.x * canvas.width);
        maxX = Math.max(maxX, p.x * canvas.width);
        minY = Math.min(minY, p.y * canvas.height);
        maxY = Math.max(maxY, p.y * canvas.height);
      }
      const size = Math.max(maxX - minX, maxY - minY) * 1.5;
      const cx = (minX + maxX) / 2,
        cy = (minY + maxY) / 2 - (maxY - minY) * 0.08;
      const sx = cx - size / 2,
        sy = cy - size / 2;
      const out = document.createElement('canvas');
      out.width = out.height = 512;
      const ctx = out.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(canvas, sx, sy, size, size, 0, 0, 512, 512);
      const toCrop = (i: number): [number, number] => [((lm[i].x * canvas.width - sx) / size) * 512, ((lm[i].y * canvas.height - sy) / size) * 512];
      const lmOut: number[] = [];
      for (const [mp] of FACE_CORR) {
        const [u, v] = toCrop(mp);
        lmOut.push(mp, u / 512, v / 512);
      }
      // colours
      // skin: median (by luminance) of several cheek / forehead patches
      const patches = [50, 280, 123, 352, 147, 376, 151, 9].map((i) => avgColor(ctx, ...toCrop(i), 7));
      patches.sort((p, q) => 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2] - (0.3 * q[0] + 0.59 * q[1] + 0.11 * q[2]));
      const mid = patches.slice(2, 6);
      const skin = [0, 1, 2].map((c) => mid.reduce((s, p) => s + p[c], 0) / mid.length) as [number, number, number];
      const irisL = lm.length > 473 ? avgColor(ctx, ...toCrop(473), 2.5) : [91, 70, 50];
      const irisR = lm.length > 468 ? avgColor(ctx, ...toCrop(468), 2.5) : [91, 70, 50];
      const eye = irisL.map((v, i) => (v + irisR[i]) / 2) as [number, number, number];
      const [fx, fy] = toCrop(10);
      const faceH = Math.hypot(toCrop(10)[0] - toCrop(152)[0], toCrop(10)[1] - toCrop(152)[1]);
      const hairC = fy - faceH * 0.1 > 6 ? avgColor(ctx, fx, fy - faceH * 0.1, 6) : null;
      const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
      const hair = hairC && Math.abs(lum(hairC) - lum(skin)) > 35 ? hex(hairC[0], hairC[1], hairC[2]) : null;
      const ratios = faceRatios((mp) => toCrop(mp));
      const data: FaceData = { crop: out.toDataURL('image/jpeg', 0.86), lm: lmOut, ratios, skin: hex(...skin), eye: hex(eye[0] * 1.1, eye[1] * 1.1, eye[2] * 1.1), hair };
      // fit face shape in a worker
      const w = new HumanWorker();
      const mods = await new Promise<Record<string, number>>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<HumanRes>) => {
          if (e.data.type === 'faceFit') resolve(e.data.mods);
          else if (e.data.type === 'error') reject(new Error(e.data.message));
        };
        w.postMessage({ type: 'faceFit', id: 1, baseUrl: new URL(import.meta.env.BASE_URL + 'human/', location.href).href, input: humanInputFor({ ...profile, avatar: { ...a, face: {} } }, live), ratios });
      });
      w.terminate();
      setFace({ ...data, mods });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
    setBusy(false);
  };

  const apply = () => {
    if (!face) return;
    setProfile({
      avatar: {
        ...a,
        face: face.mods ?? {},
        faceTexture: face.crop,
        faceLandmarks: face.lm,
        skinTone: face.skin,
        faceMean: face.skin,
        eyeColor: face.eye,
        hairColor: face.hair ?? a.hairColor,
      },
    });
    success();
    toast('Лицо перенесено на модель');
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      full
      title="Лицо по селфи"
      footer={
        <div className="row">
          {a.faceTexture && (
            <button
              className="btn danger"
              onClick={() => {
                setProfile({ avatar: { ...a, face: {}, faceTexture: null, faceLandmarks: null, faceMean: null } });
                toast('Лицо сброшено');
                onClose();
              }}
              aria-label="Сбросить лицо"
            >
              <Trash2 size={18} />
            </button>
          )}
          <button className="btn primary grow" disabled={!face} onClick={apply}>
            <CheckCircle2 size={18} /> Перенести на модель
          </button>
        </div>
      }
    >
      <p className="p" style={{ marginTop: 0 }}>
        Селфи анфас, лицо целиком, ровный дневной свет без резких теней, нейтральное выражение, волосы убраны со лба. Нейросеть найдёт 478 точек лица: форма
        подгонится по 10 пропорциям, а фото натянется на лицо модели. Цвет кожи, глаз и волос определится сам.
      </p>
      <div className="grid2" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => camRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 size={18} className="spin" /> : <Camera size={18} />} Селфи
        </button>
        <button className="btn" onClick={() => galRef.current?.click()} disabled={busy}>
          <ImageIcon size={18} /> Из галереи
        </button>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="user" hidden onChange={(e) => handle(e.target.files?.[0])} />
      <input ref={galRef} type="file" accept="image/*" hidden onChange={(e) => handle(e.target.files?.[0])} />
      {err && (
        <div className="note">
          <AlertTriangle size={16} />
          <div>{err}</div>
        </div>
      )}
      {face && (
        <div className="card glow">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <img src={face.crop} alt="" style={{ width: 120, height: 120, borderRadius: 16, objectFit: 'cover' }} />
            <div className="grow">
              <div className="row small" style={{ gap: 8 }}>
                <span className="dot" style={{ background: face.skin, width: 14, height: 14 }} /> кожа
                <span className="dot" style={{ background: face.eye, width: 14, height: 14 }} /> глаза
                {face.hair && (
                  <>
                    <span className="dot" style={{ background: face.hair, width: 14, height: 14 }} /> волосы
                  </>
                )}
              </div>
              <div className="tiny muted" style={{ marginTop: 8 }}>
                Подогнано: {RATIO_LABEL.join(', ')}.
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="tiny muted">Фото хранится только на телефоне внутри приложения.</div>
    </Sheet>
  );
}
