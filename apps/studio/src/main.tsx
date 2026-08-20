import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { useStudio } from './store.ts';
import { manifestToPartDefinition, parseManifest, validateManifest } from '@robo-journey/parts';
// Importing the library installs the built-in manifests into this thread's registry, so the
// palette is populated before the first render.
import { storedManifests } from './library.ts';
import { storedPreference } from './useThemeMode.ts';
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
    //
    // Deliberately without `registerPart`: registering a manifest on this thread alone gives a
    // part that draws and wires and then fails to simulate, which is a confusing thing to hand
    // anyone even in a console. Adding a part for real goes through the datasheet dialog.
    __parts: { manifestToPartDefinition, parseManifest, validateManifest, storedManifests },
  });
}

/*
 * Stamp the theme before anything renders.
 *
 * dockview's chrome is chosen by this attribute in CSS, and React sets it from an effect -- which
 * runs after the first paint. Doing it here as well means a light user never sees a frame of dark
 * panel chrome on the way in.
 */
document.documentElement.dataset.theme =
  storedPreference() === 'system'
    ? window.matchMedia?.('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
    : storedPreference();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
