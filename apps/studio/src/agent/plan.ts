/**
 * Checking a plan before it touches anything.
 *
 * The agent is a language model looking at a description of the workspace, and the failure mode
 * that matters is not a refusal -- it is a plan that reads perfectly and wires D13 to a pin that
 * does not exist. Applied blind, that produces a circuit which looks deliberate and is wrong, and
 * the user finds out much later.
 *
 * So every action is checked against the real registry and the real project first. Anything that
 * does not resolve is dropped *and shown*, with the reason. A silently shorter plan would be worse
 * than a refused one: the user would believe the whole thing had been done.
 *
 * Actions are checked in order against a running picture of the project, because a plan legitimately
 * adds a part in one step and wires it in the next -- so "does this part exist" means "does it
 * exist by the time this step runs".
 */
import { partDefinition, splitTerminal, type AgentAction, type Project } from './types.ts';

export interface CheckedAction {
  readonly action: AgentAction;
  /** Set when the action cannot be carried out. The action is kept so the UI can show it struck out. */
  readonly problem: string | null;
}

export interface CheckedPlan {
  readonly steps: readonly CheckedAction[];
  /** Just the ones that will run. */
  readonly runnable: readonly AgentAction[];
}

/** A breadboard hole, which is a terminal but not a pin: `12A`, `7J`. */
const HOLE = /^\d+[A-J]$/;

/** Whether a terminal names something real, given what exists at this point in the plan. */
function terminalProblem(
  terminal: string,
  parts: Map<string, string>,
): string | null {
  let partId: string;
  let pin: string;
  try {
    ({ partId, pin } = splitTerminal(terminal));
  } catch {
    return `"${terminal}" is not a terminal; it should be partId:pinName`;
  }

  const type = parts.get(partId);
  if (!type) return `there is no part called "${partId}"`;

  let definition;
  try {
    definition = partDefinition(type);
  } catch {
    return `"${type}" is not a part this app has`;
  }

  // Breadboards have holes rather than pins, and every hole is legitimate.
  if (definition.internalSpec) {
    return HOLE.test(pin) ? null : `"${pin}" is not a hole on ${partId}`;
  }

  return definition.pins.some((p) => p.name === pin)
    ? null
    : `${partId} has no pin called "${pin}"`;
}

/**
 * Check a plan against the project it would be applied to.
 *
 * Never throws and never rewrites an action: it either passes or explains itself. A validator that
 * quietly corrected the model's output would hide exactly the mistakes worth seeing.
 */
export function checkPlan(actions: readonly AgentAction[], project: Project): CheckedPlan {
  // Part id to type, as it will stand when each step runs.
  const parts = new Map(project.parts.map((p) => [p.id, p.type]));
  const wires = new Set(project.wires.map((w) => w.id));

  const steps: CheckedAction[] = [];

  for (const action of actions) {
    let problem: string | null = null;

    switch (action.kind) {
      case 'setSketch':
        if (!action.contents.trim()) problem = 'the replacement sketch is empty';
        break;

      case 'addPart': {
        if (parts.has(action.id)) {
          problem = `there is already a part called "${action.id}"`;
          break;
        }
        try {
          partDefinition(action.type);
        } catch {
          problem = `"${action.type}" is not a part this app has`;
          break;
        }
        parts.set(action.id, action.type);
        break;
      }

      case 'removePart':
        if (!parts.has(action.id)) {
          problem = `there is no part called "${action.id}"`;
          break;
        }
        parts.delete(action.id);
        // Removing a part takes its wires with it, so a later step cannot remove one of them
        // again. Tracking that here keeps the check honest about what will exist when it runs.
        for (const id of [...wires]) {
          const wire = project.wires.find((w) => w.id === id);
          if (!wire) continue;
          if (wire.from.startsWith(`${action.id}:`) || wire.to.startsWith(`${action.id}:`)) {
            wires.delete(id);
          }
        }
        break;

      case 'movePart':
      case 'rotatePart':
      case 'setProp':
        if (!parts.has(action.id)) problem = `there is no part called "${action.id}"`;
        break;

      case 'addWire': {
        problem =
          terminalProblem(action.from, parts) ?? terminalProblem(action.to, parts) ?? null;
        if (!problem && action.from === action.to) problem = 'both ends are the same terminal';
        break;
      }

      case 'removeWire':
        if (!wires.has(action.id)) problem = `there is no wire called "${action.id}"`;
        else wires.delete(action.id);
        break;
    }

    steps.push({ action, problem });
  }

  return { steps, runnable: steps.filter((s) => s.problem === null).map((s) => s.action) };
}
