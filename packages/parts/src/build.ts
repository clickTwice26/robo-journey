/**
 * From a wired-up canvas to a running circuit.
 *
 * The canvas speaks in terminals ("uno1:D13", "bb1:12A"); the solver speaks in nodes. This is the
 * single place that translation happens, which is why the UI never has to know what a node is and
 * the solver never has to know what a breadboard is.
 *
 * The Arduino is special-cased because it is not a component: it brings its own MCU, supply and
 * per-pin electrical models, and it owns the clock the whole simulation runs on.
 */
import {
  Board,
  GROUND,
  Netlist,
  Resistor,
  addBreadboard,
  type Device,
} from '@robo-journey/sim-core';
import { partDefinition } from './registry.js';
import { terminalId, type Project } from './project.js';

/**
 * Resistance of a jumper wire and of a leg pushed into a breadboard hole, ohms.
 *
 * Real, if small: 10 cm of 22 AWG is around 5 milliohms and a contact adds a little more. Modelling
 * connections as resistors rather than as identity is what lets two Arduino pins be wired together
 * without either pin's driver losing its own node.
 */
const CONNECTION_OHMS = 1e-3;

/** The Uno pins that are supply rails rather than GPIO. */
const UNO_GROUND_PINS = ['GND', 'GND2'];
const UNO_SUPPLY_PINS: Record<string, 'vcc'> = { '5V': 'vcc' };

export interface BuiltCircuit {
  readonly board: Board;
  readonly netlist: Netlist;
  /** Every terminal, resolved to the circuit node it sits on. */
  readonly nodes: ReadonlyMap<string, number>;
  /** Devices by part id, so the canvas can read an LED's brightness back. */
  readonly devices: ReadonlyMap<string, Device>;
  /** Ids of parts that could not be built, with the reason. */
  readonly problems: readonly string[];
}

export interface BuildOptions {
  readonly progMem: Uint16Array;
  readonly supplyVolts?: number;
}

/**
 * Build a simulatable circuit from a project.
 *
 * Unknown part types are reported rather than thrown: a project referencing a component this build
 * does not have should still open and run the parts it does understand.
 */
export function buildCircuit(project: Project, options: BuildOptions): BuiltCircuit {
  const board = new Board({
    progMem: options.progMem,
    ...(options.supplyVolts !== undefined ? { supplyVolts: options.supplyVolts } : {}),
  });

  const netlist = new Netlist();
  const problems: string[] = [];
  const devices = new Map<string, Device>();
  /** Terminals belonging to the Arduino, which already have board-owned nodes. */
  const unoTerminals = new Map<string, string>();

  // 1. Declare every terminal each part exposes, plus any internal connectivity.
  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      problems.push(`Unknown part type "${part.type}" (${part.id})`);
      continue;
    }

    if (definition.internalSpec) {
      // A breadboard contributes strips, not pins: its holes are its terminals.
      addBreadboard(netlist, part.id, definition.internalSpec);
    }

    for (const pin of definition.pins) {
      const terminal = terminalId(part.id, pin.name);
      netlist.add(terminal);
      if (definition.type === 'arduino-uno') unoTerminals.set(terminal, pin.name);
    }

    if (definition.type === 'arduino-uno') {
      for (const groundPin of UNO_GROUND_PINS) {
        netlist.markGround(terminalId(part.id, groundPin));
      }
    }
  }

  // 2. Wires join terminals. A wire to a terminal nothing declared is a dangling wire, not a crash.
  for (const wire of project.wires) {
    if (!netlist.has(wire.from) || !netlist.has(wire.to)) {
      problems.push(`Wire ${wire.id} connects an unknown terminal (${wire.from} -> ${wire.to})`);
      continue;
    }
    netlist.connect(wire.from, wire.to);
  }

  // 3. Every net something is plugged into becomes a circuit node.
  //
  // A half-size breadboard declares 420 holes forming 68 strips. Allocating a node per strip would
  // add 68 rows and columns of matrix that no device ever touches, and dense factorisation is
  // cubic -- it takes this circuit from 26 nodes to 111, an eightfold cost for nothing. Only nets
  // carrying a part pin or a wire end are worth solving for.
  const live = new Set<string>();
  for (const terminal of unoTerminals.keys()) live.add(terminal);
  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      continue;
    }
    for (const pin of definition.pins) live.add(terminalId(part.id, pin.name));
  }
  for (const wire of project.wires) {
    live.add(wire.from);
    live.add(wire.to);
  }

  const nodes = netlist.resolve(() => board.circuit.addNode(), (t) => live.has(t));

  // 4. Bond the Arduino's own pin nodes to whatever their nets resolved to.
  //
  // The board already owns a node per header pin, carrying that pin's driver, pull-up and leakage
  // model. Rather than trying to make the netlist reuse those nodes, join them with a jumper's
  // worth of resistance -- which is literally what the connection is.
  for (const [terminal, pinName] of unoTerminals) {
    const netNode = nodes.get(terminal);
    if (netNode === undefined) continue;

    if (UNO_GROUND_PINS.includes(pinName)) continue;

    const boardNode = UNO_SUPPLY_PINS[pinName] === 'vcc' ? board.vcc : safeBoardNode(board, pinName);
    if (boardNode === undefined) continue;
    if (boardNode === netNode) continue;

    board.circuit.add(
      new Resistor(`wire:${terminal}`, boardNode, netNode, CONNECTION_OHMS),
    );
  }

  // 5. Build each part's devices against the resolved nodes.
  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      continue;
    }
    if (!definition.build) continue;

    const props = { ...definition.defaults, ...part.props };
    try {
      definition.build({
        partId: part.id,
        props,
        node: (pin: string) => {
          const node = nodes.get(terminalId(part.id, pin));
          if (node === undefined) throw new Error(`Pin "${pin}" is not declared on ${part.id}`);
          return node;
        },
        add: (device: Device) => {
          board.circuit.add(device);
          if (!devices.has(part.id)) devices.set(part.id, device);
        },
      });
    } catch (error) {
      problems.push(`Could not build ${part.id}: ${(error as Error).message}`);
    }
  }

  return { board, netlist, nodes, devices, problems };
}

/** Header pins that are not GPIO (3V3, VIN) have no pin model; skip them rather than throwing. */
function safeBoardNode(board: Board, pinName: string): number | undefined {
  try {
    return board.node(pinName);
  } catch {
    return undefined;
  }
}

/** Ground, re-exported so callers building projects need not reach into sim-core. */
export { GROUND };
