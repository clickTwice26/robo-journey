/**
 * The project model: what a saved circuit actually is.
 *
 * Plain JSON, validated by a schema, and deliberately readable -- terminals are the labels printed
 * on the hardware ("uno1:D13", "bb1:12A"), so a diff of a project file is legible and a merge
 * conflict is resolvable. Wokwi's `diagram.json` earns the same property the same way.
 *
 * The `version` field and the optional `assertions` block are here from the start: a lesson layer
 * that checks a student's circuit needs somewhere to live that does not require reshaping the file.
 */
import { z } from 'zod';

export const PartInstanceSchema = z.object({
  /** Unique within the project, and the prefix of every terminal the part exposes. */
  id: z.string().min(1),
  /** Registry key, e.g. "led" or "breadboard-half". */
  type: z.string().min(1),
  /** Canvas position in millimetres, so the geometry stays physical rather than pixel-bound. */
  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
  /** Part-specific settings: resistance, LED colour, and so on. */
  props: z.record(z.string(), z.unknown()).default({}),
});

export const WireSchema = z.object({
  id: z.string().min(1),
  /** Terminal ids, e.g. "uno1:D13" or "bb1:12A". */
  from: z.string().min(1),
  to: z.string().min(1),
  color: z.string().default('#c0392b'),
});

export const SketchFileSchema = z.object({
  name: z.string().min(1),
  contents: z.string(),
});

export const ProjectSchema = z.object({
  version: z.literal(1),
  name: z.string().default('Untitled'),
  parts: z.array(PartInstanceSchema).default([]),
  wires: z.array(WireSchema).default([]),
  sketch: z.array(SketchFileSchema).default([]),
  /** Reserved for the teaching layer; ignored by the simulator. */
  assertions: z.array(z.unknown()).default([]),
  /** dockview layout blob, so a shared project opens with the right panels. */
  layout: z.unknown().optional(),
});

export type PartInstance = z.infer<typeof PartInstanceSchema>;
export type Wire = z.infer<typeof WireSchema>;
export type SketchFile = z.infer<typeof SketchFileSchema>;
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Give every part and wire an id that nothing else in the document is using.
 *
 * The schema calls ids unique but cannot enforce it across an array, and a duplicate is not a
 * cosmetic problem. The engine keys its devices by part id, so two parts sharing an id share one
 * device: the second one placed reads the first one's value and stops responding to anything near
 * it. That reads as a broken part rather than a broken document, which is why it is repaired on
 * the way in rather than reported.
 *
 * The original keeps its id, and with it every wire, because a terminal is `<partId>:<pin>` and a
 * wire to the second `st1` is indistinguishable from a wire to the first. The duplicate is
 * therefore renamed and left unconnected. That loses its connections, which is not nothing -- but
 * the part is still on the workspace and can be rewired, and for a stimulus, which has no pins at
 * all, the repair is exact.
 */
export function withUniqueIds(project: Project): Project {
  const taken = new Set<string>();

  /** The id itself when it is free, otherwise the first `<id>-N` that is. */
  const claim = (id: string): string => {
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
    let n = 2;
    while (taken.has(`${id}-${n}`)) n += 1;
    taken.add(`${id}-${n}`);
    return `${id}-${n}`;
  };

  const parts = project.parts.map((part) => {
    const id = claim(part.id);
    return id === part.id ? part : { ...part, id };
  });

  // Wire ids share the namespace: `nextId` draws both from one counter, so a collision between a
  // wire and a part is as reachable as one between two parts.
  const wires = project.wires.map((wire) => {
    const id = claim(wire.id);
    return id === wire.id ? wire : { ...wire, id };
  });

  return { ...project, parts, wires };
}

/** Parse and validate a project file, throwing on anything malformed. */
export function parseProject(json: unknown): Project {
  return withUniqueIds(ProjectSchema.parse(json));
}

/** A new, empty project with the stock Blink sketch. */
export function emptyProject(name = 'Untitled'): Project {
  return ProjectSchema.parse({
    version: 1,
    name,
    parts: [],
    wires: [],
    sketch: [
      {
        name: 'sketch.ino',
        contents:
          'void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\n' +
          'void loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(500);\n' +
          '  digitalWrite(LED_BUILTIN, LOW);\n  delay(500);\n}\n',
      },
    ],
  });
}

/** Terminal id for a part's pin: `<partId>:<pinName>`. */
export function terminalId(partId: string, pin: string): string {
  return `${partId}:${pin}`;
}

/** Split a terminal id back into its part and pin. */
export function splitTerminal(terminal: string): { partId: string; pin: string } {
  const index = terminal.indexOf(':');
  if (index < 0) throw new Error(`Malformed terminal id "${terminal}"`);
  return { partId: terminal.slice(0, index), pin: terminal.slice(index + 1) };
}

/**
 * Parts with at least one leg in the given board's holes.
 *
 * A leg in a hole is recorded as a wire from the part's pin to `<board>:<hole>`, so plugged-in
 * parts are exactly those on the other end of such a wire.
 *
 * Used when a board is dragged: the holes move, so whatever is sitting in them has to move too.
 * Leaving them behind detaches the circuit while making it look like a rendering fault.
 */
export function partsPluggedInto(project: Project, boardId: string): string[] {
  const prefix = `${boardId}:`;
  const attached = new Set<string>();

  for (const wire of project.wires) {
    const ends = [wire.from, wire.to];
    const boardEnd = ends.find((end) => end.startsWith(prefix));
    if (!boardEnd) continue;
    const other = ends.find((end) => end !== boardEnd);
    if (other === undefined) continue;

    const separator = other.indexOf(':');
    if (separator <= 0) continue;
    const partId = other.slice(0, separator);
    if (partId !== boardId) attached.add(partId);
  }

  return [...attached];
}
