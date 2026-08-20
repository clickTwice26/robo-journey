/**
 * React binding for the simulation worker.
 *
 * The worker is created once and driven through comlink. The UI polls a snapshot each animation
 * frame rather than the worker pushing updates: the engine should never be blocked waiting on a
 * renderer, and a dropped frame should cost a frame of staleness, not a queue of backed-up
 * messages.
 */
import * as Comlink from 'comlink';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ChannelSpec, DisasmLine } from '@robo-journey/sim-core';
import type { ComponentManifest, Project } from '@robo-journey/parts';
import { useStudio } from '../store.ts';
import type { DecodedFrame, McuState, SimApi, TraceData } from './protocol.ts';

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
  /** Teach the worker about a manifest-described part. See `library.ts`. */
  registerManifest(manifest: ComponentManifest): void;
  setPartProp(partId: string, key: string, value: unknown): void;

  // Queries. These return promises because the engine lives in a worker.
  channels(): Promise<ChannelSpec[]>;
  watchAnalog(label: string): void;
  traces(ids: string[], from: number, to: number, maxPoints?: number): Promise<TraceData[]>;
  captureSpan(): Promise<{ from: number; to: number }>;
  decodeSerial(id: string, from: number, to: number): Promise<DecodedFrame[]>;
  mcuState(): Promise<McuState>;
  disassembly(from: number, to: number): Promise<DisasmLine[]>;
  setBreakpoint(byteAddress: number): void;
  clearBreakpoint(byteAddress: number): void;
  clearBreakpoints(): void;
  breakpoints(): Promise<number[]>;
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

  /** Query the worker, returning a safe default when it is not up yet. */
  const query = useCallback(
    async <T,>(run: (api: Comlink.Remote<SimApi>) => Promise<T>, fallback: T): Promise<T> => {
      const api = apiRef.current;
      if (!api) return fallback;
      try {
        return await run(api);
      } catch {
        // A query racing a worker teardown is not worth surfacing; the next poll will succeed.
        return fallback;
      }
    },
    [],
  );

  /**
   * Memoised so the controller is referentially stable.
   *
   * Without this every render produces a new object, which invalidates any memo keyed on it --
   * dockview would tear down and rebuild every panel on each render, and the scope's polling
   * effect would restart continuously.
   */
  return useMemo<SimulationController>(() => ({
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
    registerManifest: (manifest) => call('registerManifest', manifest),
    setPartProp: (partId, key, value) => call('setPartProp', partId, key, value),

    channels: () => query((api) => api.channels(), []),
    watchAnalog: (label) => call('watchAnalog', label),
    traces: (ids, from, to, maxPoints) =>
      query((api) => api.traces(ids, from, to, maxPoints), []),
    captureSpan: () => query((api) => api.captureSpan(), { from: 0, to: 0 }),
    decodeSerial: (id, from, to) => query((api) => api.decodeSerial(id, from, to), []),
    mcuState: () =>
      query((api) => api.mcuState(), {
        pc: 0,
        stackPointer: 0,
        sreg: 0,
        cycles: 0,
        registers: [],
        gpr: [],
      }),

    disassembly: (from, to) => query((api) => api.disassembly(from, to), []),
    setBreakpoint: (byteAddress) => call('setBreakpoint', byteAddress),
    clearBreakpoint: (byteAddress) => call('clearBreakpoint', byteAddress),
    clearBreakpoints: () => call('clearBreakpoints'),
    breakpoints: () => query((api) => api.breakpoints(), []),
  }), [call, query]);
}
