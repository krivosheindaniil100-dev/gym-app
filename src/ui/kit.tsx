import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { pushBack, tap } from '../lib/native';

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  full,
  right,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  full?: boolean;
  right?: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return pushBack(() => closeRef.current());
  }, [open]);
  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className={`sheet ${full ? 'full' : ''}`} role="dialog">
        <div className="sheet-head">
          <div className="sheet-handle" />
          {title !== undefined && (
            <div className="sheet-title">
              <h2>{title}</h2>
              <div className="row">
                {right}
                <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
                  <X size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; l: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={String(o.v)}
          className={o.v === value ? 'on' : ''}
          onClick={() => {
            tap();
            onChange(o.v);
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange, multi, scroll }: { value: T | T[]; options: { v: T; l: ReactNode }[]; onChange: (v: any) => void; multi?: boolean; scroll?: boolean }) {
  const sel = Array.isArray(value) ? value : [value];
  return (
    <div className={`chips ${scroll ? 'scroll' : ''}`}>
      {options.map((o) => (
        <button
          key={o.v}
          className={`chip ${sel.includes(o.v) ? 'on' : ''}`}
          onClick={() => {
            tap();
            if (multi) onChange(sel.includes(o.v) ? sel.filter((x) => x !== o.v) : [...sel, o.v]);
            else onChange(o.v);
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={() => (tap(), onChange(!on))} aria-pressed={on} />;
}

export function Ring({ value, max, size = 132, stroke = 12, color = 'var(--accent)', track = 'rgba(255,255,255,0.07)', children }: { value: number; max: number; size?: number; stroke?: number; color?: string; track?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const over = max > 0 && value > max;
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={over ? 'var(--amber)' : color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          style={{ transition: 'stroke-dasharray .7s cubic-bezier(.22,1,.36,1)', filter: `drop-shadow(0 0 6px ${over ? 'rgba(255,181,71,.5)' : 'rgba(124,247,200,.35)'})` }}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

export function MacroBar({ label, value, target, color }: { label: string; value: number; target: number; color: string }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row between small" style={{ marginBottom: 5 }}>
        <span style={{ fontWeight: 650 }}>
          <span className="dot" style={{ background: color, marginRight: 7 }} />
          {label}
        </span>
        <span className="num muted">
          <b style={{ color: 'var(--text)' }}>{Math.round(value)}</b> / {Math.round(target)} г
        </span>
      </div>
      <div className="macro-bar">
        <div style={{ width: `${pct}%`, background: color, boxShadow: `0 0 10px ${color}` }} />
      </div>
    </div>
  );
}

let toastSetter: ((t: { text: string; id: number } | null) => void) | null = null;
export function toast(text: string) {
  toastSetter?.({ text, id: Date.now() });
}
export function ToastHost() {
  const [t, setT] = useState<{ text: string; id: number } | null>(null);
  useEffect(() => {
    toastSetter = setT;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), 2600);
    return () => clearTimeout(h);
  }, [t?.id]);
  if (!t) return null;
  return (
    <div className="toast" key={t.id}>
      {t.text}
    </div>
  );
}

/** Numeric text field that lets the user type freely (comma or dot). */
export function NumField({
  value,
  onChange,
  suffix,
  placeholder,
  big,
  autoFocus,
  step,
  className,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  suffix?: string;
  placeholder?: string;
  big?: boolean;
  autoFocus?: boolean;
  step?: number;
  className?: string;
}) {
  const [text, setText] = useState(value === undefined || Number.isNaN(value) ? '' : String(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      const cur = Number(text.replace(',', '.'));
      if (value === undefined) setText('');
      else if (cur !== value) setText(String(Math.round(value * 100) / 100));
    }
  }, [value]);
  return (
    <div className="input-wrap">
      <input
        className={`input ${big ? 'big-input' : ''} ${className ?? ''}`}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        step={step}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,-]/g, '');
          setText(t);
          const n = Number(t.replace(',', '.'));
          const v = t === '' || Number.isNaN(n) ? undefined : n;
          last.current = v;
          onChange(v);
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      {text && <div className="small" style={{ lineHeight: 1.5 }}>{text}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
export const signed = (v: number, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d);
