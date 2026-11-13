import { useEffect, useMemo, useState } from 'react';
import { useApp } from './store';
import { calibrationBias, compFromMeasurement, liveState, sortedMeasurements, type Composition, type LiveState } from './energy';
import { computeTargets, type Targets } from './nutrition';
import { addDays, dayKey } from './date';

/** Re-render every `ms` (live mode). */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), ms);
    const vis = () => !document.hidden && setNow(new Date());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [ms]);
  return now;
}

export function useLedgerInput() {
  const profile = useApp((s) => s.profile);
  const measurements = useApp((s) => s.measurements);
  const food = useApp((s) => s.food);
  const activity = useApp((s) => s.activity);
  return useMemo(() => ({ profile, measurements, food, activity }), [profile, measurements, food, activity]);
}

export function useBias() {
  const input = useLedgerInput();
  return useMemo(() => (input.profile.calibrate ? calibrationBias(input) : 0), [input]);
}

export function useLive(now: Date): LiveState | null {
  const input = useLedgerInput();
  const bias = useBias();
  return useMemo(() => liveState(input, now, bias), [input, now.getTime(), bias]);
}

export function useTargets(comp: Composition | null): Targets | null {
  const profile = useApp((s) => s.profile);
  const plan = useApp((s) => s.plan);
  const activity = useApp((s) => s.activity);
  return useMemo(() => {
    if (!comp) return null;
    let avgWatch: number | undefined;
    if (profile.activityMode === 'watch') {
      const vals: number[] = [];
      for (let i = 1; i <= 7; i++) {
        const v = activity[addDays(dayKey(), -i)]?.watchActiveKcal;
        if (v) vals.push(v);
      }
      if (vals.length) avgWatch = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return computeTargets(profile, comp, plan, avgWatch);
  }, [profile, plan, comp?.ffm, comp?.weight, activity]);
}

export function useLatestMeasurement() {
  const ms = useApp((s) => s.measurements);
  return useMemo(() => {
    const s = sortedMeasurements(ms);
    return s.length ? s[s.length - 1] : null;
  }, [ms]);
}

export function useBaseComp(): Composition | null {
  const m = useLatestMeasurement();
  return useMemo(() => (m ? compFromMeasurement(m) : null), [m]);
}
