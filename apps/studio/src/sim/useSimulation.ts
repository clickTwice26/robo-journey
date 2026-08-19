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

/**
 * A fingerprint of everything about a project that changes the *circuit*.
 *
 * Deliberately excludes the sketch: retyping code must not rebuild the netlist on every keystroke,
 * and firmware only reaches the worker through an explicit compile. Part properties are included
 * because a resistance or a switch position does change the stamps.
 */
function circuitFingerprint(project: Project): string {
  return JSON.stringify([
    project.parts.map((p) => [p.id, p.type, p.x, p.y, p.rotation, p.props]),
    project.wires.map((w) => [w.id, w.from, w.to]),
  ]);
}

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
  const project = useStudio((s) => s.project);
  const fingerprint = circuitFingerprint(project);
  const lastFingerprint = useRef<string | null>(null);

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

  /**
   * Keep the worker's circuit in step with the canvas.
   *
   * Without this, editing the circuit -- moving a wire, changing a resistor, loading an example --
   * leaves the simulation running the circuit you had before, which is worse than not simulating
   * at all because it looks like it is working.
   */
  useEffect(() => {
    if (lastFingerprint.current === fingerprint) return;
    lastFingerprint.current = fingerprint;
    void apiRef.current?.loadProject(project);
  }, [fingerprint, project]);

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
    load: (loaded, hex) => {
      // The explicit compile path carries both, so record the fingerprint to avoid an immediate
      // redundant rebuild from the effect above.
      lastFingerprint.current = circuitFingerprint(loaded);
      call('load', loaded, hex);
    },
    setPartProp: (partId, key, value) => call('setPartProp', partId, key, value),
  };
}
