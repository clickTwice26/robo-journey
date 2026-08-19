/**
 * React binding for the simulation worker.
 *
 * The worker is created once and driven through comlink. The UI polls a snapshot each animation
 * frame rather than the worker pushing updates: the engine should never be blocked waiting on a
 * renderer, and a dropped frame should cost a frame of staleness, not a queue of backed-up
 * messages.
 */
import * as Comlink from 'comlink';
import { useCallback, useEffect, useRef } from 'react';
import type { Project } from '@robo-journey/parts';
import { useStudio } from '../store.ts';
import type { SimApi } from './protocol.ts';

export interface SimulationController {
  start(): void;
  pause(): void;
  reset(): void;
  stepInstruction(): void;
  stepTime(seconds: number): void;
  load(project: Project, hex: string): void;
  setPartProp(partId: string, key: string, value: unknown): void;
}

export function useSimulation(): SimulationController {
  const apiRef = useRef<Comlink.Remote<SimApi> | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const frameRef = useRef<number>(0);
  const setSnapshot = useStudio((s) => s.setSnapshot);

  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    apiRef.current = Comlink.wrap<SimApi>(worker);

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled) return;
      // One outstanding request at a time. Without this guard a slow frame queues snapshots and
      // the UI ends up rendering history.
      if (!inFlight && apiRef.current) {
        inFlight = true;
        try {
          const snapshot = await apiRef.current.snapshot();
          if (!cancelled) setSnapshot(snapshot);
        } finally {
          inFlight = false;
        }
      }
      frameRef.current = requestAnimationFrame(poll);
    };
    frameRef.current = requestAnimationFrame(poll);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameRef.current);
      worker.terminate();
    };
  }, [setSnapshot]);

  const call = useCallback(<K extends keyof SimApi>(method: K, ...args: Parameters<SimApi[K]>) => {
    const api = apiRef.current;
    if (!api) return;
    // comlink proxies are async; nothing here needs the result.
    void (api[method] as (...a: unknown[]) => Promise<unknown>)(...args);
  }, []);

  return {
    start: () => call('start'),
    pause: () => call('pause'),
    reset: () => call('reset'),
    stepInstruction: () => call('stepInstruction'),
    stepTime: (seconds) => call('stepTime', seconds),
    load: (project, hex) => call('load', project, hex),
    setPartProp: (partId, key, value) => call('setPartProp', partId, key, value),
  };
}
