/**
 * Carrying out a plan, one step at a time and in the open.
 *
 * Applied all at once, an agent edit is a project that changed while you were looking at the chat
 * panel: correct, perhaps, and impossible to follow. So the steps run in sequence with a pause
 * between them, the canvas selects whatever each step is about, and the plan list marks each one
 * off as it goes. You watch it happen and you can see which step did what.
 *
 * Every step goes through the ordinary store actions -- the same ones a click uses. Nothing here
 * reaches past them into the project, which is what keeps undo working, keeps the worker in step,
 * and means the agent cannot do anything a person could not do by hand.
 */
import { useStudio } from '../store.ts';
import { subjectOf, type AgentAction } from './types.ts';

/** How long each step is left on screen. Long enough to follow, short enough not to be a wait. */
export const STEP_MS = 420;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Apply one action. Synchronous: the animation is the pause between steps, not inside them. */
function apply(action: AgentAction): void {
  const store = useStudio.getState();

  switch (action.kind) {
    case 'setSketch':
      store.setSketch('sketch.ino', action.contents);
      break;

    case 'addPart':
      store.addPart({
        id: action.id,
        type: action.type,
        x: action.x,
        y: action.y,
        rotation: action.rotation ?? 0,
        props: (action.props ?? {}) as Record<string, unknown>,
      });
      break;

    case 'removePart':
      store.removePart(action.id);
      break;

    case 'movePart':
      store.movePart(action.id, action.x, action.y);
      break;

    case 'rotatePart':
      store.rotatePart(action.id, action.rotation);
      break;

    case 'setProp':
      store.updatePartProps(action.id, { [action.key]: action.value });
      break;

    case 'addWire':
      store.addWire({
        // Wire ids are the app's to hand out, not the model's: one it invented could collide with
        // a wire already on the canvas.
        id: `ag${Math.floor(Date.now() % 1e7)}${Math.floor(Math.random() * 1000)}`,
        from: action.from,
        to: action.to,
        // A wire always has a colour; the model naming one is optional.
        color: action.color ?? '#c0392b',
      });
      break;

    case 'removeWire':
      store.removeWire(action.id);
      break;
  }
}

export interface RunHandle {
  /** Ask the run to stop after the step in flight. */
  cancel(): void;
}

/**
 * Run a plan.
 *
 * `onStep` is called before each action with its index, so the panel can mark progress, and the
 * canvas selection follows the step's subject -- which is most of what makes this legible: the
 * part being changed is the one lit up while the note about it is on screen.
 */
export async function runPlan(
  actions: readonly AgentAction[],
  onStep: (index: number) => void,
  handle?: { cancelled: boolean },
): Promise<number> {
  const store = useStudio.getState();
  let done = 0;

  for (const [index, action] of actions.entries()) {
    if (handle?.cancelled) break;

    onStep(index);

    // Light up whatever this step is about before changing it, so the change is seen where the
    // eye already is.
    const subject = subjectOf(action);
    if (subject) {
      store.setAgentFocus(subject);
      if (action.kind !== 'addPart') store.setSelection(subject);
    }

    await sleep(STEP_MS / 2);
    apply(action);
    if (subject && action.kind === 'addPart') useStudio.getState().setSelection(subject);
    done += 1;
    await sleep(STEP_MS / 2);
  }

  useStudio.getState().setAgentFocus(null);
  return done;
}
