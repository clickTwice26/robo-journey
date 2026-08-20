import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { useStudio } from './store.ts';
import {
  manifestToPartDefinition,
  parseManifest,
  registerPart,
  validateManifest,
} from '@robo-journey/parts';
import './index.css';

/**
 * Development handle on the store.
 *
 * Exposed from the app's own module graph rather than dynamically imported from a console, which
 * makes Vite serve a second copy of React and produces "invalid hook call" errors that look like
 * an app bug. Stripped from production builds by the DEV guard.
 */
if (import.meta.env.DEV) {
  Object.assign(globalThis, {
    __studio: useStudio,
    // Enough to load a manifest by hand and see it on the canvas, which is how a rendering
    // problem gets reproduced without spending an extraction each time.
    __parts: { registerPart, manifestToPartDefinition, parseManifest, validateManifest },
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
