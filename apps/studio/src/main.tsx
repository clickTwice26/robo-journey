import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { useStudio } from './store.ts';
import { manifestToPartDefinition, parseManifest, validateManifest } from '@robo-journey/parts';
// Importing the library installs the built-in manifests into this thread's registry, so the
// palette is populated before the first render.
import { storedManifests } from './library.ts';
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

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
