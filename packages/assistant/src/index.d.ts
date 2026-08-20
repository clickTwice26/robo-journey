/**
 * @robo-journey/assistant
 *
 * The in-app assistant. Server-side only: it holds the API key, so importing it into the browser
 * would put the key in the bundle.
 */
export { AssistantError, DEFAULT_CHAT_MODEL, MAX_OUTPUT_TOKENS, MAX_QUESTION_CHARS, SYSTEM_INSTRUCTION, ask, estimateChatCredits, } from './chat.js';
export type { ChatMessage, ChatReply, ChatRequest, ChatRole } from './chat.js';
export { describeWorkspace } from './context.js';
export type { Fault, WorkspaceContext } from './context.js';
export { CREDITS_PER_1K_INPUT, CREDITS_PER_1K_OUTPUT, MINIMUM_CHARGE, creditsFor, estimateCredits, estimateTokens, } from './pricing.js';
export type { TokenUsage } from './pricing.js';
//# sourceMappingURL=index.d.ts.map