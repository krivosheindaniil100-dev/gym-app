// Dev-only preview of the realistic human (open /?devhuman&fat=20&ffm=68&sex=male&h=182)
import HumanViewer from './human/HumanViewer';
export default function DevHuman() {
  const q = new URLSearchParams(location.search);
  const sex = (q.get('sex') as 'male' | 'female') || 'male';
  const fat = Number(q.get('fat') || 19.8);
  const ffm = Number(q.get('ffm') || 67.9);
  const h = Number(q.get('h') || 182);
  const glutes = Number(q.get('glutes') || 1);
  const ghost = q.get('ghost');
  return (
    <div style={{ width: '100vw', height: '100vh', background: 'radial-gradient(120% 80% at 50% 10%, #1a2133, #07080c)' }}>
      <HumanViewer
        input={{ sex, heightCm: h, weight: fat + ffm, fatKg: fat, ffm, age: 29, pattern: glutes !== 1 ? { glutes } : undefined }}
        ghost={ghost ? { sex, heightCm: h, weight: Number(ghost) + ffm, fatKg: Number(ghost), ffm, age: 29 } : null}
        showRings={q.get('rings') === '1'}
        view={q.get('view') ? { name: q.get('view') as 'front', nonce: 1 } : undefined}
      />
    </div>
  );
}
