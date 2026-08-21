/**
 * What the agent is allowed to do.
 *
 * The assistant in Ask mode returns prose. In Agent mode it returns a *plan*: a list of concrete,
 * checkable edits to the project. That distinction is deliberate and it is the whole safety model
 * -- the agent never touches the workspace itself, it proposes a list of changes that the app
 * validates against the real registry and the real project, shows to the user, and only then
 * applies.
 *
 * The vocabulary is small on purpose. Every action here maps onto something the user could already
 * do by hand, which means there is nothing the agent can do that cannot be undone, inspected, or
 * explained in the same terms as a manual edit. An action that changed a setting with no UI, or
 * reached outside the project, would be a hole in that.
 *
 * Each action carries its own `note` -- one line saying why -- so the plan reads as reasoning
 * rather than as a diff, and so a user can refuse one step for a stated reason.
 *
 * It lives here, beside the project model it describes, rather than in the assistant package. The
 * browser has to know this vocabulary to check a plan and apply it, and the assistant package holds
 * the API key -- importing that into the app would put the key in the bundle.
 */
import { z } from 'zod';

/** Kept modest: a plan longer than this is the model rebuilding the project rather than editing it. */
export const MAX_ACTIONS = 40;

const Note = z.string().min(1).max(200);
const PartId = z.string().min(1).max(64);
/** `partId:pinName`, the same terminal id the canvas and the netlist use. */
const Terminal = z.string().min(3).max(130);

export const AgentActionSchema = z.discriminatedUnion('kind', [
  /**
   * Replace the sketch.
   *
   * Whole-file rather than a patch. A patch format is a second thing to get right for no gain
   * here: sketches are short, the editor shows the result immediately, and one undo restores the
   * previous version either way.
   */
  z.object({
    kind: z.literal('setSketch'),
    contents: z.string().max(20_000),
    note: Note,
  }),

  z.object({
    kind: z.literal('addPart'),
    /** The id it will have, so later actions in the same plan can wire to it. */
    id: PartId,
    type: z.string().min(1).max(64),
    x: z.number().finite(),
    y: z.number().finite(),
    rotation: z.number().finite().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    note: Note,
  }),

  z.object({ kind: z.literal('removePart'), id: PartId, note: Note }),

  z.object({
    kind: z.literal('movePart'),
    id: PartId,
    x: z.number().finite(),
    y: z.number().finite(),
    note: Note,
  }),

  z.object({
    kind: z.literal('rotatePart'),
    id: PartId,
    rotation: z.number().finite(),
    note: Note,
  }),

  /** A property of a placed part: a resistance, a colour, how bright the lamp is. */
  z.object({
    kind: z.literal('setProp'),
    id: PartId,
    key: z.string().min(1).max(64),
    value: z.union([z.number(), z.string(), z.boolean()]),
    note: Note,
  }),

  z.object({
    kind: z.literal('addWire'),
    from: Terminal,
    to: Terminal,
    color: z.string().max(32).optional(),
    note: Note,
  }),

  z.object({ kind: z.literal('removeWire'), id: z.string().min(1).max(64), note: Note }),
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentActionKind = AgentAction['kind'];

export const AgentPlanSchema = z.object({
  /** One or two sentences on what the plan does, shown above the steps. */
  summary: z.string().min(1).max(1200),
  actions: z.array(AgentActionSchema).max(MAX_ACTIONS),
});

export type AgentPlan = z.infer<typeof AgentPlanSchema>;

/** A short human label for an action, for the plan list and for progress messages. */
export function describeAction(action: AgentAction): string {
  switch (action.kind) {
    case 'setSketch':
      return 'Rewrite the sketch';
    case 'addPart':
      return `Add ${action.type} as ${action.id}`;
    case 'removePart':
      return `Remove ${action.id}`;
    case 'movePart':
      return `Move ${action.id}`;
    case 'rotatePart':
      return `Turn ${action.id} to ${action.rotation}°`;
    case 'setProp':
      return `Set ${action.id} ${action.key} to ${String(action.value)}`;
    case 'addWire':
      return `Wire ${action.from} to ${action.to}`;
    case 'removeWire':
      return `Remove wire ${action.id}`;
  }
}

/** Which part an action is about, so the canvas can select it while the step runs. */
export function subjectOf(action: AgentAction): string | null {
  switch (action.kind) {
    case 'addPart':
    case 'removePart':
    case 'movePart':
    case 'rotatePart':
    case 'setProp':
      return action.id;
    case 'addWire':
      return action.from.split(':')[0] ?? null;
    default:
      return null;
  }
}

/**
 * Parse whatever the model returned into a plan.
 *
 * Returns null rather than throwing when the reply is not a plan at all: the model declining to
 * act -- because the question was a question, or because it does not know what to do -- is an
 * ordinary outcome, and the answer text is still worth showing.
 */
export function parsePlan(raw: string): AgentPlan | null {
  const text = raw.trim();
  if (!text) return null;

  // Models sometimes wrap JSON in a fence even when asked not to.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced?.[1] ?? text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const result = AgentPlanSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
