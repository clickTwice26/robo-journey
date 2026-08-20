export const CREDITS_PER_1K_INPUT = 1;
export const CREDITS_PER_1K_OUTPUT = 4;
/** Nothing is free, however short. A question that costs nothing is a question worth spamming. */
export const MINIMUM_CHARGE = 1;
export function creditsFor(usage) {
    const raw = (usage.input / 1000) * CREDITS_PER_1K_INPUT + (usage.output / 1000) * CREDITS_PER_1K_OUTPUT;
    return Math.max(MINIMUM_CHARGE, Math.ceil(raw));
}
/**
 * Roughly how many tokens a string is, without a tokenizer.
 *
 * Four characters per token is the usual rule of thumb for English, and it is deliberately rounded
 * *up* here: this feeds the estimate that gets held, and an estimate that comes in under the true
 * cost would mean settling for more than was held, which is refused. Erring high costs the user
 * nothing -- the difference is returned -- while erring low would cost them an error.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 3.5);
}
/**
 * What to hold before a call, given the prompt and the most the model may return.
 *
 * A ceiling, not a guess. The exact figure is known only afterwards, and the difference comes back
 * at settlement.
 */
export function estimateCredits(promptText, maxOutputTokens) {
    return creditsFor({ input: estimateTokens(promptText), output: maxOutputTokens });
}
//# sourceMappingURL=pricing.js.map