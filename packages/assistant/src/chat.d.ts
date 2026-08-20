import { type WorkspaceContext } from './context.js';
import { type TokenUsage } from './pricing.js';
/**
 * Default model.
 *
 * A conversational task where latency is felt directly, unlike datasheet extraction where accuracy
 * is worth waiting for. Overridable, because the model list moves.
 */
export declare const DEFAULT_CHAT_MODEL = "gemini-3.7-flash";
/**
 * Ceiling on an answer.
 *
 * Also the basis of the estimate that gets held, so it is a real limit rather than a formality:
 * without one the hold would have to assume an unbounded answer and nobody could afford to ask.
 */
export declare const MAX_OUTPUT_TOKENS = 1200;
/** A single question that will not fit in a question box has gone wrong somewhere. */
export declare const MAX_QUESTION_CHARS = 4000;
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
export declare class AssistantError extends Error {
}
/**
 * What the assistant is and is not.
 *
 * Most of this is about staying honest. The simulator's whole claim is that it tells you the truth
 * about your circuit, and an assistant that confidently invents a pinout or agrees with a wrong
 * premise undoes that faster than any bug -- so it is told to read the workspace rather than
 * recall the part, and to say when the workspace does not answer the question.
 */
export declare const SYSTEM_INSTRUCTION: string;
/** Roughly what to hold before asking, so a caller can check affordability first. */
export declare function estimateChatCredits(request: Omit<ChatRequest, 'apiKey'>): number;
/**
 * Ask.
 *
 * Reports the usage of the call as well as the answer, because the caller has to settle a hold
 * against what it actually cost -- and because a feature that spends money without saying how much
 * is one nobody can reason about.
 */
export declare function ask(request: ChatRequest): Promise<ChatReply>;
//# sourceMappingURL=chat.d.ts.map