import { useMemo, useRef, useState } from 'react';

export const CHART = {
  line: '#4fb6dc',
  deficit: '#26a87d',
  surplus: '#c97d16',
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.14)',
  surface: '#0c0f16',
};

export interface LinePoint {
  x: number; // ms
  y: number;
  measured?: boolean;
}

function niceTicks(min: number, max: number, n = 4) {
  const span = max - min || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5) ?? step0;
  const lo = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= max + step * 0.001; v += step) if (v >= min - step * 0.001) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const fmtD = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

/** Single-series trend line; measured points drawn as ringed dots. Tap/drag → crosshair + tooltip. */
export function LineChart({ points, unit, digits = 1, height = 170 }: { points: LinePoint[]; unit: string; digits?: number; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 340;
  const H = height;
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x0 = Math.min(...xs),
      x1 = Math.max(...xs);
    let y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    const padY = Math.max((y1 - y0) * 0.15, 0.3);
    y0 -= padY;
    y1 += padY;
    const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
    return { x0, x1, y0, y1, sx, sy, ticks: niceTicks(y0, y1, 3) };
  }, [points, H]);
  if (!geo) return <div className="small muted" style={{ padding: '24px 0', textAlign: 'center' }}>Мало данных для графика</div>;
  const { sx, sy } = geo;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const area = `${path} L${sx(points[points.length - 1].x)},${H - pad.b} L${sx(points[0].x)},${H - pad.b} Z`;
  const onMove = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    let best = 0,
      bd = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(sx(p.x) - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={ref}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerMove={(e) => (e.buttons || e.pointerType === 'mouse') && onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: 'pan-y' }}
      >
        <defs>
          <linearGradient id="lg-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={CHART.line} stopOpacity="0.22" />
            <stop offset="1" stopColor={CHART.line} stopOpacity="0" />
          </linearGradient>
        </defs>
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke={CHART.grid} />
            <text x={pad.l - 6} y={sy(t) + 3.5} textAnchor="end">
              {t.toLocaleString('ru-RU')}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 5}>
          {fmtD(geo.x0)}
        </text>
        <text x={W - pad.r} y={H - 5} textAnchor="end">
          {fmtD(geo.x1)}
        </text>
        <path d={area} fill="url(#lg-area)" />
        <path d={path} fill="none" stroke={CHART.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) =>
          p.measured ? <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={CHART.line} stroke={CHART.surface} strokeWidth={2} /> : null,
        )}
        {hp && (
          <g>
            <line x1={sx(hp.x)} x2={sx(hp.x)} y1={pad.t} y2={H - pad.b} stroke={CHART.axis} />
            <circle cx={sx(hp.x)} cy={sy(hp.y)} r={5} fill="#fff" stroke={CHART.surface} strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="badge"
          style={{
            position: 'absolute',
            top: 0,
            left: `${(sx(hp.x) / W) * 100}%`,
            transform: `translateX(${sx(hp.x) > W * 0.7 ? '-100%' : sx(hp.x) < W * 0.3 ? '0' : '-50%'})`,
            background: 'rgba(16,20,29,.95)',
            border: '1px solid var(--border-2)',
            color: 'var(--text)',
            height: 'auto',
            padding: '5px 8px',
            pointerEvents: 'none',
          }}
        >
          {fmtD(hp.x)} · <b>{hp.y.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits })} {unit}</b>
          {hp.measured ? ' · замер' : ''}
        </div>
      )}
    </div>
  );
}

export interface BarPoint {
  key: string;
  label: string;
  v: number | null; // null = not logged
}

/** Diverging bars around zero: deficit (below 0) vs surplus (above 0). */
export function BalanceBars({ data, height = 150 }: { data: BarPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 340;
  const H = height;
  const pad = { l: 34, r: 6, t: 10, b: 18 };
  const vals = data.map((d) => d.v ?? 0);
  const m = Math.max(300, ...vals.map(Math.abs));
  const ticks = niceTicks(-m, m, 4);
  const lo = Math.min(-m, ticks[0]);
  const hi = Math.max(m, ticks[ticks.length - 1]);
  const sy = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const gap = 2;
  const r = Math.min(4, (bw - gap) / 2);
  const hd = hover !== null ? data[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? CHART.axis : CHART.grid} />
            <text x={pad.l - 6} y={sy(t) + 3.5} textAnchor="end">
              {t === 0 ? '0' : (t > 0 ? '+' : '−') + Math.abs(t).toLocaleString('ru-RU')}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * bw + gap / 2;
          const w = Math.max(1, bw - gap);
          if (d.v === null) return <rect key={d.key} x={x + w / 2 - 1} y={sy(0) - 1} width={2} height={2} fill={CHART.axis} />;
          const y0 = sy(0);
          const y1 = sy(d.v);
          const top = Math.min(y0, y1);
          const h = Math.max(1, Math.abs(y1 - y0));
          const pos = d.v > 0;
          // rounded data-end, flat at the baseline
          const rr = Math.min(r, h);
          const pth = pos
            ? `M${x},${y0} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + w - rr} Q${x + w},${top} ${x + w},${top + rr} V${y0} Z`
            : `M${x},${y0} V${top + h - rr} Q${x},${top + h} ${x + rr},${top + h} H${x + w - rr} Q${x + w},${top + h} ${x + w},${top + h - rr} V${y0} Z`;
          return (
            <g key={d.key} onPointerDown={() => setHover(i)} onPointerEnter={() => setHover(i)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              <path d={pth} fill={pos ? CHART.surplus : CHART.deficit} opacity={hover === null || hover === i ? 1 : 0.45} />
            </g>
          );
        })}
        <text x={pad.l} y={H - 3}>
          {data[0]?.label}
        </text>
        <text x={W - pad.r} y={H - 3} textAnchor="end">
          {data[data.length - 1]?.label}
        </text>
      </svg>
      {hd && (
        <div className="small" style={{ marginTop: 4, textAlign: 'center' }}>
          <b>{hd.label}</b>:{' '}
          {hd.v === null ? <span className="muted">нет записей</span> : <b className="num">{(hd.v > 0 ? '+' : '−') + Math.abs(Math.round(hd.v)).toLocaleString('ru-RU')} ккал ({(hd.v > 0 ? '+' : '−') + Math.abs(Math.round((hd.v / 7700) * 1000))} г жира)</b>}
        </div>
      )}
    </div>
  );
}
