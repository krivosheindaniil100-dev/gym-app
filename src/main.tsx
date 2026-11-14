import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
import './styles/app.css';
import App from './App';

const DevHuman = lazy(() => import('./devHuman'));
const dev = import.meta.env.DEV && location.search.includes('devhuman');

createRoot(document.getElementById('root')!).render(
  dev ? (
    <Suspense fallback={null}>
      <DevHuman />
    </Suspense>
  ) : (
    <App />
  ),
);
