import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Dumbbell, LineChart, PersonStanding, UtensilsCrossed } from 'lucide-react';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { useApp } from './lib/store';
import { isNative, onWebScanRequest, popBack, resolveWebScan, tap, type ScanKind } from './lib/native';
import { Sheet, ToastHost } from './ui/kit';
import Onboarding from './screens/Onboarding';
import BodyScreen from './screens/Body';

const NutritionScreen = lazy(() => import('./screens/Nutrition'));
const TrainingScreen = lazy(() => import('./screens/Training'));
const ProgressScreen = lazy(() => import('./screens/Progress'));

export type Tab = 'body' | 'food' | 'train' | 'progress';

const TABS: { id: Tab; label: string; icon: typeof Dumbbell }[] = [
  { id: 'body', label: 'Тело', icon: PersonStanding },
  { id: 'food', label: 'Питание', icon: UtensilsCrossed },
  { id: 'train', label: 'Тренировки', icon: Dumbbell },
  { id: 'progress', label: 'Прогресс', icon: LineChart },
];

function WebScanSheet() {
  const [kind, setKind] = useState<ScanKind | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    onWebScanRequest((k) => {
      setText('');
      setKind(k);
    });
  }, []);
  const close = (v: string | null) => {
    setKind(null);
    resolveWebScan(v);
  };
  return (
    <Sheet
      open={!!kind}
      onClose={() => close(null)}
      title={kind === 'qr' ? 'QR-код (веб-режим)' : 'Штрихкод (веб-режим)'}
      footer={
        <button className="btn primary block" disabled={!text.trim()} onClick={() => close(text.trim())}>
          Готово
        </button>
      }
    >
      <p className="p">Камера доступна в Android-приложении. Здесь можно вставить содержимое кода вручную.</p>
      <textarea className="input" style={{ height: 110, padding: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'qr' ? 'weight=80.5;pbf=18.2;smm=36.4' : '4607001234567'} autoFocus />
    </Sheet>
  );
}

export default function App() {
  const hydrated = useApp((s) => s.hydrated);
  const onboarded = useApp((s) => s.onboarded);
  const hasData = useApp((s) => s.measurements.length > 0);
  const [tab, setTab] = useState<Tab>('body');
  const [visited, setVisited] = useState<Set<Tab>>(new Set(['body']));
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;

  useEffect(() => {
    if (!isNative()) return;
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    StatusBar.setBackgroundColor({ color: '#07080c' }).catch(() => {});
    const sub = CapApp.addListener('backButton', () => {
      if (popBack()) return;
      if (tabRef.current !== 'body') setTab('body');
      else CapApp.minimizeApp();
    });
    return () => {
      sub.then((s) => s.remove());
    };
  }, []);
  useEffect(() => {
    if (hydrated && isNative()) SplashScreen.hide().catch(() => {});
  }, [hydrated]);

  const go = (t: Tab) => {
    tap();
    setTab(t);
    setVisited((v) => new Set(v).add(t));
  };

  if (!hydrated) return <div className="app" />;
  if (!onboarded || !hasData)
    return (
      <div className="app">
        <Onboarding />
        <WebScanSheet />
        <ToastHost />
      </div>
    );

  return (
    <div className="app">
      <div style={{ display: tab === 'body' ? 'block' : 'none' }}>
        <BodyScreen active={tab === 'body'} onNavigate={go} />
      </div>
      <Suspense fallback={null}>
        {visited.has('food') && (
          <div style={{ display: tab === 'food' ? 'block' : 'none' }}>
            <NutritionScreen active={tab === 'food'} />
          </div>
        )}
        {visited.has('train') && (
          <div style={{ display: tab === 'train' ? 'block' : 'none' }}>
            <TrainingScreen active={tab === 'train'} />
          </div>
        )}
        {visited.has('progress') && (
          <div style={{ display: tab === 'progress' ? 'block' : 'none' }}>
            <ProgressScreen active={tab === 'progress'} />
          </div>
        )}
      </Suspense>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            <t.icon size={22} strokeWidth={tab === t.id ? 2.3 : 1.9} />
            {t.label}
          </button>
        ))}
      </nav>
      <WebScanSheet />
      <ToastHost />
    </div>
  );
}
