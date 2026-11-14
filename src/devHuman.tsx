// Dev-only preview of the realistic human:
//   /?devhuman&view=front|side|back|face&sex=male|female&fat=20&ffm=68&h=182&hair=short02&tone=c39880&eye=brown&ghost=30&rings=1
import HumanViewer, { DEFAULT_APPEARANCE } from './human/HumanViewer';
export default function DevHuman() {
  const q = new URLSearchParams(location.search);
  const sex = (q.get('sex') as 'male' | 'female') || 'male';
  const fat = Number(q.get('fat') || 19.8);
  const ffm = Number(q.get('ffm') || 67.9);
  const h = Number(q.get('h') || 182);
  const glutes = Number(q.get('glutes') || 1);
  const ghost = q.get('ghost');
  return (
    <div className="hero" style={{ width: '100vw', height: '100vh', margin: 0 }}>
      <HumanViewer
        input={{ sex, heightCm: h, weight: fat + ffm, fatKg: fat, ffm, age: Number(q.get('age') || 29), pattern: glutes !== 1 ? { glutes } : undefined }}
        ghost={ghost ? { sex, heightCm: h, weight: Number(ghost) + ffm, fatKg: Number(ghost), ffm, age: 29 } : null}
        appearance={{
          ...DEFAULT_APPEARANCE,
          hairStyle: q.get('hair') ?? (sex === 'female' ? 'long01' : 'buzz'),
          skinTone: q.get('tone') ? '#' + q.get('tone') : DEFAULT_APPEARANCE.skinTone,
          eyeColor: q.get('eye') ?? 'brown',
          hairColor: q.get('haircolor') ? '#' + q.get('haircolor') : DEFAULT_APPEARANCE.hairColor,
        }}
        showRings={q.get('rings') === '1'}
        view={q.get('view') ? { name: q.get('view') as 'front', nonce: 1 } : undefined}
      />
    </div>
  );
}
