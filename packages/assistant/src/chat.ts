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
}

export interface ChatReply {
  readonly answer: string;
  readonly usage: TokenUsage;
  readonly credits: number;
  readonly model: string;
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

Style: direct and technical, the way a colleague at the next bench would answer. Markdown, short
paragraphs, code fences for sketch code. No preamble, no restating the question, no sign-off.
`.trim();

/** Roughly what to hold before asking, so a caller can check affordability first. */
export function estimateChatCredits(request: Omit<ChatRequest, 'apiKey'>): number {
  return estimateCredits(buildPrompt(request), MAX_OUTPUT_TOKENS);
}

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
  const ai = new GoogleGenAI({ apiKey: request.apiKey });
  const prompt = buildPrompt(request);

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Some variation is wanted in prose, but this is a technical assistant answering questions
        // about measured values, not a writing one.
        temperature: 0.3,
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

  return { answer, usage, credits: creditsFor(usage), model };
}
