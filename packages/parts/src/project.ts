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

/** Parse and validate a project file, throwing on anything malformed. */
export function parseProject(json: unknown): Project {
  return ProjectSchema.parse(json);
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
