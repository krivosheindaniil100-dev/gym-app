import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Barcode, Clock, Globe, Loader2, PackagePlus, Pencil, Search, Star, Trash2, Zap } from 'lucide-react';
import { FOODS } from '../data/foods';
import { useApp } from '../lib/store';
import { Chips, NumField, Seg, Sheet, fmt, toast } from '../ui/kit';
import { fetchByBarcode, searchOff, type OffResult } from '../lib/off';
import { scanCode, success, tap } from '../lib/native';
import { uid } from '../lib/date';
import type { Food, FoodEntry, FoodUnit, MealSlot, Per100 } from '../lib/types';

export const MEAL_LABEL: Record<MealSlot, string> = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' };
export const MEALS: MealSlot[] = ['breakfast', 'lunch', 'snack', 'dinner'];

export function mealByTime(d = new Date()): MealSlot {
  const h = d.getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 18) return 'snack';
  return 'dinner';
}

export interface Pickable {
  id: string;
  name: string;
  brand?: string;
  per100: Per100;
  units?: FoodUnit[];
  source?: Food['source'];
  barcode?: string;
  imageUrl?: string;
  note?: string;
  quality?: OffResult['quality'];
  defaultGrams?: number;
}

const normq = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

function searchLocal(q: string, foods: Food[]): Food[] {
  const n = normq(q);
  if (!n) return [];
  const words = n.split(/\s+/);
  const scored: { f: Food; s: number }[] = [];
  for (const f of foods) {
    const name = normq(f.name + ' ' + (f.brand ?? ''));
    if (!words.every((w) => name.includes(w))) continue;
    let s = 0;
    if (name.startsWith(n)) s += 5;
    if (name.split(/[\s(,]+/).some((w) => w.startsWith(words[0]))) s += 2;
    s -= name.length / 60;
    if (f.source === 'custom') s += 1;
    scored.push({ f, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.f);
}

/* ───────────────────────── Add food ───────────────────────── */

export function AddFoodSheet({ open, onClose, day, meal }: { open: boolean; onClose: () => void; day: string; meal: MealSlot }) {
  const custom = useApp((s) => s.customFoods);
  const recent = useApp((s) => s.recentFoods);
  const addFood = useApp((s) => s.addFood);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'recent' | 'mine' | 'base'>('recent');
  const [pick, setPick] = useState<Pickable | null>(null);
  const [online, setOnline] = useState<OffResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState<{ barcode?: string; base?: Pickable } | null>(null);
  const [quick, setQuick] = useState(false);

  useEffect(() => {
    if (open) {
      setQ('');
      setOnline(null);
      setTab(recent.length ? 'recent' : 'base');
    }
  }, [open]);

  const all = useMemo(() => [...custom, ...FOODS], [custom]);
  const results = useMemo(() => searchLocal(q, all), [q, all]);

  const scan = async () => {
    tap();
    try {
      const code = await scanCode('product');
      if (!code) return;
      const mine = custom.find((f) => f.barcode === code);
      if (mine) {
        setPick({ ...mine });
        return;
      }
      setLoading(true);
      const r = await fetchByBarcode(code).catch(() => undefined);
      setLoading(false);
      if (r === undefined) {
        toast('Нет связи с базой продуктов');
        setCreateOpen({ barcode: code });
      } else if (!r) {
        toast('Продукт не найден — добавьте его один раз по этикетке');
        setCreateOpen({ barcode: code });
      } else {
        setPick({ ...r.food, note: r.note, quality: r.quality, defaultGrams: r.servingGrams });
      }
    } catch (e) {
      setLoading(false);
      toast('Сканер недоступен: ' + String((e as Error).message ?? e));
    }
  };

  const searchOnline = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      setOnline(await searchOff(q));
    } catch {
      toast('Не удалось подключиться к Open Food Facts');
      setOnline([]);
    }
    setLoading(false);
  };

  const list: Pickable[] = q.trim()
    ? results
    : tab === 'recent'
      ? recent.map((r) => ({ ...r, defaultGrams: r.lastGrams }))
      : tab === 'mine'
        ? custom
        : FOODS.slice(0, 60);

  return (
    <>
      <Sheet open={open && !pick && !createOpen && !quick} onClose={onClose} title={`Добавить · ${MEAL_LABEL[meal]}`} full>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="search grow">
            <Search size={18} className="muted" />
            <input value={q} onChange={(e) => (setQ(e.target.value), setOnline(null))} placeholder="Поиск: гречка, творог, банан…" autoFocus={false} />
          </div>
          <button className="icon-btn accent" style={{ width: 48, height: 48 }} onClick={scan} aria-label="Сканировать штрихкод">
            {loading ? <Loader2 size={20} className="spin" /> : <Barcode size={22} />}
          </button>
        </div>
        {!q.trim() && (
          <div style={{ marginBottom: 8 }}>
            <Chips
              value={tab}
              options={[
                { v: 'recent', l: <><Clock size={14} /> Недавние</> },
                { v: 'mine', l: <><Star size={14} /> Мои</> },
                { v: 'base', l: 'База' },
              ]}
              onChange={setTab}
            />
          </div>
        )}
        <div className="grid2" style={{ margin: '4px 0 6px' }}>
          <button className="btn sm" onClick={() => setQuick(true)}>
            <Zap size={16} /> Только ккал
          </button>
          <button className="btn sm" onClick={() => setCreateOpen({})}>
            <PackagePlus size={16} /> Свой продукт
          </button>
        </div>
        <div className="list">
          {list.map((f) => (
            <FoodRow key={f.id} f={f} onClick={() => setPick({ ...f })} />
          ))}
          {!list.length && !q.trim() && tab === 'recent' && <div className="empty small">Здесь появятся продукты, которые ты добавлял.</div>}
          {!list.length && !q.trim() && tab === 'mine' && <div className="empty small">Свои продукты и всё, что ты сканировал и исправил.</div>}
        </div>
        {q.trim() && (
          <div style={{ marginTop: 10 }}>
            {!online && (
              <button className="btn block" onClick={searchOnline} disabled={loading}>
                {loading ? <Loader2 size={18} className="spin" /> : <Globe size={18} />} Искать «{q.trim()}» в интернете
              </button>
            )}
            {online && (
              <>
                <div className="section-label">Open Food Facts</div>
                {!online.length && <div className="small muted">Ничего не найдено. Попробуйте отсканировать штрихкод.</div>}
                <div className="list">
                  {online.map((r) => (
                    <FoodRow key={r.food.id} f={r.food} onClick={() => setPick({ ...r.food, note: r.note, quality: r.quality, defaultGrams: r.servingGrams })} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Sheet>
      <PortionSheet
        open={!!pick}
        item={pick}
        initialMeal={meal}
        onClose={() => setPick(null)}
        onEditValues={(p) => {
          setPick(null);
          setCreateOpen({ base: p, barcode: p.barcode });
        }}
        onSave={(grams, m, item) => {
          addFood(day, { time: entryTime(day), meal: m, name: item.name, brand: item.brand, foodId: item.id, grams, per100: item.per100 });
          useApp.getState().rememberFood(item as Food, grams);
          success();
          toast(`${item.name}: ${fmt((item.per100.kcal * grams) / 100)} ккал`);
          setPick(null);
          onClose();
        }}
      />
      <CustomFoodSheet
        open={!!createOpen}
        barcode={createOpen?.barcode}
        base={createOpen?.base}
        onClose={() => setCreateOpen(null)}
        onSaved={(f) => {
          setCreateOpen(null);
          setPick({ ...f });
        }}
      />
      <QuickKcalSheet
        open={quick}
        meal={meal}
        onClose={() => setQuick(false)}
        onSave={(name, kcal, p, fat, c, m) => {
          addFood(day, { time: entryTime(day), meal: m, name, grams: 100, per100: { kcal, p, f: fat, c } });
          success();
          setQuick(false);
          onClose();
        }}
      />
    </>
  );
}

export function entryTime(day: string) {
  const now = new Date();
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
  // past day: put it at noon so it falls within the day
  if (day !== `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`) t.setHours(12, 0, 0);
  return t.toISOString();
}

function FoodRow({ f, onClick }: { f: Pickable; onClick: () => void }) {
  return (
    <div className="item" onClick={onClick} role="button">
      {f.imageUrl ? <img className="food-img" src={f.imageUrl} alt="" loading="lazy" /> : <div className="food-img">{f.name.slice(0, 1)}</div>}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="title ellipsis">{f.name}</div>
        <div className="meta ellipsis">
          {f.brand ? f.brand + ' · ' : ''}Б {fmt(f.per100.p, 1)} · Ж {fmt(f.per100.f, 1)} · У {fmt(f.per100.c, 1)}
        </div>
      </div>
      <div className="right">
        <div className="bold num">{fmt(f.per100.kcal)}</div>
        <div className="tiny muted">ккал/100 г</div>
      </div>
    </div>
  );
}

/* ───────────────────────── Portion (grams typed with keyboard) ───────────────────────── */

export function PortionSheet({
  open,
  item,
  initialMeal,
  initialGrams,
  onClose,
  onSave,
  onDelete,
  onEditValues,
  title,
}: {
  open: boolean;
  item: Pickable | null;
  initialMeal: MealSlot;
  initialGrams?: number;
  onClose: () => void;
  onSave: (grams: number, meal: MealSlot, item: Pickable) => void;
  onDelete?: () => void;
  onEditValues?: (p: Pickable) => void;
  title?: string;
}) {
  const [grams, setGrams] = useState<number | undefined>(100);
  const [meal, setMeal] = useState<MealSlot>(initialMeal);
  const [unitCount, setUnitCount] = useState<{ label: string; n: number } | null>(null);
  useEffect(() => {
    if (open && item) {
      setGrams(initialGrams ?? item.defaultGrams ?? item.units?.[0]?.grams ?? 100);
      setMeal(initialMeal);
      setUnitCount(null);
    }
  }, [open, item?.id]);
  if (!item) return null;
  const g = grams ?? 0;
  const k = g / 100;
  const m = { kcal: item.per100.kcal * k, p: item.per100.p * k, f: item.per100.f * k, c: item.per100.c * k };
  const quickG = [50, 100, 150, 200, 250, 300];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title ?? 'Сколько съел?'}
      footer={
        <div className="row">
          {onDelete && (
            <button className="btn danger" onClick={onDelete} aria-label="Удалить">
              <Trash2 size={18} />
            </button>
          )}
          <button className="btn primary grow" disabled={!g || g <= 0} onClick={() => onSave(Math.round(g * 10) / 10, meal, item)}>
            {onDelete ? 'Сохранить' : 'Добавить'} · {fmt(m.kcal)} ккал
          </button>
        </div>
      }
    >
      <div className="row" style={{ marginBottom: 14 }}>
        {item.imageUrl ? <img className="food-img" src={item.imageUrl} alt="" /> : <div className="food-img">{item.name.slice(0, 1)}</div>}
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="bold">{item.name}</div>
          <div className="small muted">
            {item.brand ? item.brand + ' · ' : ''}
            {fmt(item.per100.kcal)} ккал · Б {fmt(item.per100.p, 1)} Ж {fmt(item.per100.f, 1)} У {fmt(item.per100.c, 1)} на 100 г
          </div>
        </div>
        {onEditValues && (
          <button className="icon-btn" onClick={() => onEditValues(item)} aria-label="Исправить КБЖУ">
            <Pencil size={16} />
          </button>
        )}
      </div>
      {item.note && (
        <div className="note">
          <AlertTriangle size={16} />
          <div>{item.note}</div>
        </div>
      )}
      <NumField value={grams} onChange={(v) => (setGrams(v), setUnitCount(null))} suffix="г" big autoFocus />
      <div className="chips" style={{ marginTop: 12 }}>
        {item.units?.map((u) => (
          <button
            key={u.label}
            className={`chip ${unitCount?.label === u.label ? 'on' : ''}`}
            onClick={() => {
              tap();
              const n = unitCount?.label === u.label ? unitCount.n + 1 : 1;
              setUnitCount({ label: u.label, n });
              setGrams(Math.round(u.grams * n * 10) / 10);
            }}
          >
            {unitCount?.label === u.label ? `${unitCount.n} × ` : ''}
            {u.label} · {fmt(u.grams)} г
          </button>
        ))}
        {quickG.map((q) => (
          <button key={q} className={`chip ${g === q && !unitCount ? 'on' : ''}`} onClick={() => (tap(), setGrams(q), setUnitCount(null))}>
            {q} г
          </button>
        ))}
      </div>
      <div className="grid3" style={{ margin: '16px 0', textAlign: 'center' }}>
        <MacroBox label="Белки" v={m.p} color="var(--protein)" />
        <MacroBox label="Жиры" v={m.f} color="var(--fat)" />
        <MacroBox label="Углеводы" v={m.c} color="var(--carbs)" />
      </div>
      <Seg value={meal} options={MEALS.map((x) => ({ v: x, l: MEAL_LABEL[x] }))} onChange={setMeal} />
    </Sheet>
  );
}

function MacroBox({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div className="stat" style={{ padding: '10px 6px' }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 22, color }}>
        {fmt(v, 1)}
        <small>г</small>
      </div>
    </div>
  );
}

/* ───────────────────────── Custom product ───────────────────────── */

export function CustomFoodSheet({ open, onClose, barcode, base, onSaved }: { open: boolean; onClose: () => void; barcode?: string; base?: Pickable; onSaved: (f: Food) => void }) {
  const save = useApp((s) => s.saveCustomFood);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [v, setV] = useState<Partial<Per100>>({});
  const [unitG, setUnitG] = useState<number | undefined>();
  useEffect(() => {
    if (!open) return;
    setName(base?.name ?? '');
    setBrand(base?.brand ?? '');
    setV(base ? { ...base.per100 } : {});
    setUnitG(base?.units?.[0]?.grams);
  }, [open]);
  const calc = (v.p ?? 0) * 4 + (v.f ?? 0) * 9 + (v.c ?? 0) * 4;
  const ok = name.trim() && v.kcal !== undefined && v.p !== undefined && v.f !== undefined && v.c !== undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={base ? 'Исправить КБЖУ' : 'Свой продукт'}
      full
      footer={
        <button
          className="btn primary block"
          disabled={!ok}
          onClick={() => {
            const f: Food = {
              id: base?.source === 'custom' ? base.id : `custom_${uid()}`,
              name: name.trim(),
              brand: brand.trim() || undefined,
              barcode: barcode || base?.barcode,
              category: 'other',
              per100: { kcal: v.kcal!, p: v.p!, f: v.f!, c: v.c!, fiber: v.fiber },
              units: unitG ? [{ label: 'порция / шт', grams: unitG }] : base?.units,
              source: 'custom',
              imageUrl: base?.imageUrl,
            };
            save(f);
            toast('Сохранено в «Мои продукты»');
            onSaved(f);
          }}
        >
          Сохранить
        </button>
      }
    >
      {barcode && (
        <div className="badge" style={{ marginBottom: 12 }}>
          <Barcode size={12} /> {barcode}
        </div>
      )}
      <p className="p" style={{ marginTop: 0 }}>
        Перепиши значения «на 100 г» с этикетки. В следующий раз при сканировании этого штрихкода продукт найдётся сразу.
      </p>
      <div className="field">
        <label>Название</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Творог «Простоквашино» 5%" />
      </div>
      <div className="field">
        <label>Бренд</label>
        <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="необязательно" />
      </div>
      <div className="grid2">
        <div className="field">
          <label>Калории на 100 г</label>
          <NumField value={v.kcal} onChange={(x) => setV({ ...v, kcal: x })} suffix="ккал" />
        </div>
        <div className="field">
          <label>Белки</label>
          <NumField value={v.p} onChange={(x) => setV({ ...v, p: x })} suffix="г" />
        </div>
        <div className="field">
          <label>Жиры</label>
          <NumField value={v.f} onChange={(x) => setV({ ...v, f: x })} suffix="г" />
        </div>
        <div className="field">
          <label>Углеводы</label>
          <NumField value={v.c} onChange={(x) => setV({ ...v, c: x })} suffix="г" />
        </div>
        <div className="field">
          <label>Клетчатка</label>
          <NumField value={v.fiber} onChange={(x) => setV({ ...v, fiber: x })} suffix="г" placeholder="—" />
        </div>
        <div className="field">
          <label>Вес порции / шт</label>
          <NumField value={unitG} onChange={setUnitG} suffix="г" placeholder="—" />
        </div>
      </div>
      {v.kcal !== undefined && v.p !== undefined && v.f !== undefined && v.c !== undefined && Math.abs(calc - v.kcal) / Math.max(v.kcal, 1) > 0.15 && (
        <div className="note">
          <AlertTriangle size={16} />
          <div>
            По БЖУ выходит {fmt(calc)} ккал, а указано {fmt(v.kcal)}. Проверь, не перепутаны ли значения «на порцию» и «на 100 г».
          </div>
        </div>
      )}
    </Sheet>
  );
}

/* ───────────────────────── Quick kcal ───────────────────────── */

function QuickKcalSheet({ open, onClose, onSave, meal }: { open: boolean; onClose: () => void; meal: MealSlot; onSave: (name: string, kcal: number, p: number, f: number, c: number, meal: MealSlot) => void }) {
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState<number | undefined>();
  const [p, setP] = useState<number | undefined>();
  const [f, setF] = useState<number | undefined>();
  const [c, setC] = useState<number | undefined>();
  const [m, setM] = useState<MealSlot>(meal);
  useEffect(() => {
    if (open) {
      setName('');
      setKcal(undefined);
      setP(undefined);
      setF(undefined);
      setC(undefined);
      setM(meal);
    }
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Быстрая запись"
      footer={
        <button className="btn primary block" disabled={!kcal} onClick={() => onSave(name.trim() || 'Быстрая запись', kcal!, p ?? 0, f ?? 0, c ?? 0, m)}>
          Добавить
        </button>
      }
    >
      <div className="field">
        <label>Что это</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Обед в кафе" />
      </div>
      <div className="field">
        <label>Калории</label>
        <NumField value={kcal} onChange={setKcal} suffix="ккал" big autoFocus />
      </div>
      <div className="grid3">
        <div className="field">
          <label>Белки</label>
          <NumField value={p} onChange={setP} suffix="г" />
        </div>
        <div className="field">
          <label>Жиры</label>
          <NumField value={f} onChange={setF} suffix="г" />
        </div>
        <div className="field">
          <label>Углев.</label>
          <NumField value={c} onChange={setC} suffix="г" />
        </div>
      </div>
      <Seg value={m} options={MEALS.map((x) => ({ v: x, l: MEAL_LABEL[x] }))} onChange={setM} />
    </Sheet>
  );
}

export function entryToPickable(e: FoodEntry): Pickable {
  return { id: e.foodId ?? e.id, name: e.name, brand: e.brand, per100: e.per100 };
}
