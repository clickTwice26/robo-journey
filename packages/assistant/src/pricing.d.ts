/**
 * What an AI call costs, in credits.
 *
 * Credits are integers and deliberately coarse. The alternative -- billing fractions of a cent per
 * token -- means a balance nobody can reason about and rounding arguments nobody can win. A whole
 * credit is the smallest thing anyone is charged.
 *
 * Output is dearer than input because it is dearer to produce, and because it is the half the user
 * controls least: a long answer to a short question should not be free to ask for.
 */
export interface TokenUsage {
    readonly input: number;
    readonly output: number;
}
export declare const CREDITS_PER_1K_INPUT = 1;
export declare const CREDITS_PER_1K_OUTPUT = 4;
/** Nothing is free, however short. A question that costs nothing is a question worth spamming. */
export declare const MINIMUM_CHARGE = 1;
export declare function creditsFor(usage: TokenUsage): number;
/**
 * Roughly how many tokens a string is, without a tokenizer.
 *
 * Four characters per token is the usual rule of thumb for English, and it is deliberately rounded
 * *up* here: this feeds the estimate that gets held, and an estimate that comes in under the true
 * cost would mean settling for more than was held, which is refused. Erring high costs the user
 * nothing -- the difference is returned -- while erring low would cost them an error.
 */
export declare function estimateTokens(text: string): number;
/**
 * What to hold before a call, given the prompt and the most the model may return.
 *
 * A ceiling, not a guess. The exact figure is known only afterwards, and the difference comes back
 * at settlement.
 */
export declare function estimateCredits(promptText: string, maxOutputTokens: number): number;
//# sourceMappingURL=pricing.d.ts.map