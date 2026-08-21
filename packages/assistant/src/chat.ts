/**
 * The assistant.
 *
 * Answers questions about the circuit that is actually on screen. That is the whole point: a model
 * with no context can only recite the usual reasons an LED does not light, while one that can see
 * there is no series resistor between D13 and the anode says so, names the pin, and quotes the
 * current the simulator measured.
 *
 * Built so the agent can arrive later without this being rewritten. A turn is already a list of
 * messages with roles, the usage of every call is already reported so it can be billed, and the
 * model call is behind one function -- which is where tool definitions and a tool-call loop go
 * when the assistant starts changing the circuit rather than describing it.
 */
import { GoogleGenAI } from '@google/genai';
import { describeWorkspace, type WorkspaceContext } from './context.js';
import { estimateCredits, creditsFor, type TokenUsage } from './pricing.js';
import { MAX_ACTIONS, parsePlan, type AgentPlan } from '@robo-journey/parts';

/**
 * Default model.
 *
 * A conversational task where latency is felt directly, unlike datasheet extraction where accuracy
 * is worth waiting for. Overridable, because the model list moves.
 */
export const DEFAULT_CHAT_MODEL = 'gemini-3.7-flash';

/**
 * Ceiling on an answer.
 *
 * Also the basis of the estimate that gets held, so it is a real limit rather than a formality:
 * without one the hold would have to assume an unbounded answer and nobody could afford to ask.
 */
export const MAX_OUTPUT_TOKENS = 1200;

/**
 * Ceiling on a plan.
 *
 * Higher than an answer because a plan can carry a rewritten sketch inside it, and a plan cut off
 * halfway is not a shorter plan -- it is invalid JSON and a wasted call. The hold is sized from
 * this, so agent turns are held against more and settle back the difference like any other.
 */
export const MAX_AGENT_OUTPUT_TOKENS = 4000;

/** Ask answers; Agent proposes edits. The user picks, and the model is told which it is. */
export type AssistantMode = 'ask' | 'agent';

/** How much conversation to carry. Enough to follow a thread; not enough to bill for an essay. */
const MAX_HISTORY_TURNS = 12;
/** A single question that will not fit in a question box has gone wrong somewhere. */
export const MAX_QUESTION_CHARS = 4000;

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatRequest {
  readonly apiKey: string;
  readonly model?: string;
  readonly question: string;
  readonly history?: readonly ChatMessage[];
  readonly workspace: WorkspaceContext;
  readonly mode?: AssistantMode;
}

export interface ChatReply {
  readonly answer: string;
  readonly usage: TokenUsage;
  readonly credits: number;
  readonly model: string;
  /**
   * The edits the agent proposes, when it proposed any.
   *
   * Null in Ask mode, and also in Agent mode when the model chose to answer rather than act --
   * which is the right response to a question, and to a request it cannot carry out.
   */
  readonly plan: AgentPlan | null;
}

export class AssistantError extends Error {}

/**
 * What the assistant is and is not.
 *
 * Most of this is about staying honest. The simulator's whole claim is that it tells you the truth
 * about your circuit, and an assistant that confidently invents a pinout or agrees with a wrong
 * premise undoes that faster than any bug -- so it is told to read the workspace rather than
 * recall the part, and to say when the workspace does not answer the question.
 */
export const SYSTEM_INSTRUCTION = `
You are the assistant inside robo-journey, a hardware-accurate Arduino circuit simulator. The user
is looking at a circuit and a sketch, and you are shown both.

How to answer:
- Read the workspace before answering. Name real part ids, pin names and measured values from it.
  "R1 is 220 ohm and D13 is at 4.8 V" beats "check your resistor".
- When the workspace already explains the problem, say so directly and say what to change.
- The simulator reports faults with real measured numbers. If one is present and relevant, lead
  with it rather than speculating about other causes.
- If the workspace does not contain what you would need, say which part of it you cannot see
  rather than guessing. Never invent a pinout, a part number, or a measurement.
- If the user's premise is wrong -- a part wired the way they describe would not behave the way
  they expect -- say so plainly rather than answering the question as asked.
- Electronics, this simulator, and the Arduino sketch are the subject. Decline anything else
  briefly and get back to the circuit.

Style: direct and technical, the way a colleague at the next bench would answer. Short paragraphs.
No preamble, no restating the question, no sign-off.

Formatting: plain Markdown only -- paragraphs, lists, backtick code, and fenced blocks tagged
\`cpp\` for sketch code. No LaTeX and no maths delimiters: nothing renders them, so a dollar-sign
expression reaches the reader exactly as written. Write V_IL, or just "VIL", and put units after
the number as a datasheet does -- 1.50 V, 220 ohm, 93.3 mA.
`.trim();

/**
 * What the agent may do, and how it must say so.
 *
 * Written as tightly as the Ask instruction and for the same reason. An agent that guesses a pin
 * name produces a plan that looks right and wires the circuit wrong, and the user finds out when
 * the LED does not light -- so it is told to work from the ids and pins in front of it, and to
 * answer in prose when it is not sure rather than acting on a guess.
 *
 * The escape hatch matters as much as the vocabulary: returning no actions is always allowed and
 * is the correct answer to a question, to a request it cannot carry out, and to anything it would
 * have to invent a part number to attempt.
 */
export const AGENT_INSTRUCTION = `
You are the agent inside robo-journey, a hardware-accurate Arduino circuit simulator. You are shown
the circuit on screen and the sketch, and you can change both.

Reply with JSON only. No prose outside it, no markdown fence. The shape is exactly:

{"summary": "one or two sentences on what you are doing and why",
 "actions": [ ... ]}

Each action is one of:
{"kind":"setSketch","contents":"<the whole sketch>","note":"why"}
{"kind":"addPart","id":"r2","type":"resistor","x":40,"y":80,"props":{"ohms":220},"note":"why"}
{"kind":"removePart","id":"r2","note":"why"}
{"kind":"movePart","id":"r2","x":40,"y":80,"note":"why"}
{"kind":"rotatePart","id":"fs1","rotation":90,"note":"why"}
{"kind":"setProp","id":"r2","key":"ohms","value":330,"note":"why"}
{"kind":"addWire","from":"uno1:D13","to":"r2:a","note":"why"}
{"kind":"removeWire","id":"w3","note":"why"}

Rules:
- Use only part ids, part types, pin names and wire ids that appear in the workspace you were
  given. Never invent one. If you need a part type that is not listed, say so in the summary and
  return no actions.
- A terminal is "partId:pinName" exactly as the workspace lists it.
- A part you add in one action can be wired in a later action in the same plan. Give it an id that
  is not already taken.
- Coordinates are millimetres. Place new parts in clear space near what they connect to, not on
  top of an existing part.
- setSketch replaces the whole file. Include every line, not a fragment, and keep what already
  works.
- Prefer the smallest plan that does the job. Fixing what was asked beats rebuilding the circuit.
- At most ${MAX_ACTIONS} actions.

Returning {"summary": "...", "actions": []} is always allowed and is the right reply when the user
asked a question rather than for a change, when the workspace does not contain what you would need,
or when you are not sure. Say why in the summary. An empty plan with an honest reason is a better
answer than a plan built on a guess.
`.trim();

/** Roughly what to hold before asking, so a caller can check affordability first. */
export function estimateChatCredits(request: Omit<ChatRequest, 'apiKey'>): number {
  return estimateCredits(buildPrompt(request), outputLimitFor(request.mode ?? 'ask'));
}

const outputLimitFor = (mode: AssistantMode): number =>
  mode === 'agent' ? MAX_AGENT_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;

function buildPrompt(request: Omit<ChatRequest, 'apiKey'>): string {
  const history = (request.history ?? [])
    .slice(-MAX_HISTORY_TURNS)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');

  return [
    '## The workspace right now',
    describeWorkspace(request.workspace),
    history ? `## Earlier in this conversation\n${history}` : '',
    `## The question\n${request.question.slice(0, MAX_QUESTION_CHARS)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Ask.
 *
 * Reports the usage of the call as well as the answer, because the caller has to settle a hold
 * against what it actually cost -- and because a feature that spends money without saying how much
 * is one nobody can reason about.
 */
export async function ask(request: ChatRequest): Promise<ChatReply> {
  const question = request.question.trim();
  if (!question) throw new AssistantError('Ask something.');

  const model = request.model ?? DEFAULT_CHAT_MODEL;
  const mode = request.mode ?? 'ask';
  const ai = new GoogleGenAI({ apiKey: request.apiKey });
  const prompt = buildPrompt(request);

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: mode === 'agent' ? AGENT_INSTRUCTION : SYSTEM_INSTRUCTION,
        maxOutputTokens: outputLimitFor(mode),
        // Some variation is wanted in prose, but this is a technical assistant answering questions
        // about measured values, not a writing one. A plan wants less still: there is a right
        // answer to "which pin", and creativity about it is only ever wrong.
        temperature: mode === 'agent' ? 0.1 : 0.3,
        ...(mode === 'agent' ? { responseMimeType: 'application/json' } : {}),
      },
    });
  } catch (error) {
    throw new AssistantError(
      `The assistant could not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const answer = response.text?.trim() ?? '';
  if (!answer) throw new AssistantError('The assistant returned nothing.');

  // Reported by the API where available, and estimated from the text where it is not -- billing
  // nothing because a field was missing would be a way to get free answers.
  const usage: TokenUsage = {
    input: response.usageMetadata?.promptTokenCount ?? Math.ceil(prompt.length / 3.5),
    output: response.usageMetadata?.candidatesTokenCount ?? Math.ceil(answer.length / 3.5),
  };

  // In agent mode the reply *is* the plan. A reply that will not parse is not an error worth
  // failing the turn over -- the summary is still worth reading -- so the plan comes back null and
  // the user sees what the model said and no proposed edits.
  const plan = mode === 'agent' ? parsePlan(answer) : null;
  const text = mode === 'agent' ? (plan?.summary ?? answer) : answer;

  return { answer: text, usage, credits: creditsFor(usage), model, plan };
}
