import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { useStudio } from './store.ts';
import './index.css';

/**
 * Development handle on the store.
 *
 * Exposed from the app's own module graph rather than dynamically imported from a console, which
 * makes Vite serve a second copy of React and produces "invalid hook call" errors that look like
 * an app bug. Stripped from production builds by the DEV guard.
 */
if (import.meta.env.DEV) {
  (globalThis as { __studio?: typeof useStudio }).__studio = useStudio;
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
