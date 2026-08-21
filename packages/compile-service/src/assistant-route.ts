/**
 * The assistant, over HTTP.
 *
 * The interesting part is not the model call, it is the money around it. A language model's cost
 * is not known until it has answered, so the sequence is: estimate, hold that much, ask, settle
 * against what it actually cost. Anything simpler is wrong in one of two ways -- charging up front
 * overcharges every short answer, and charging afterwards lets an empty account run an expensive
 * call.
 *
 * The hold is released on every failure path. Nobody pays for an answer they did not get, and a
 * hold that leaks is credits that vanish with no entry in the ledger explaining where.
 */
import type { FastifyInstance } from 'fastify';
import {
  AssistantError,
  MAX_QUESTION_CHARS,
  ask,
  estimateChatCredits,
  type AssistantMode,
  type ChatMessage,
  type WorkspaceContext,
} from '@robo-journey/assistant';
import { InsufficientCreditsError, type AccountStore } from '@robo-journey/accounts';
import type { Redis } from 'ioredis';
import { RedisRateLimiter } from './redis.js';
import type { Guards } from './session-guard.js';

export interface AssistantRouteOptions {
  readonly store: AccountStore;
  readonly guards: Guards;
  readonly redis: Redis;
  readonly apiKey: string | undefined;
}

interface ChatBody {
  question?: string;
  history?: ChatMessage[];
  workspace?: WorkspaceContext;
  mode?: string;
}

/** How many turns of history a client may send back. Beyond this it is padding the context. */
const MAX_HISTORY = 24;

export function registerAssistantRoutes(
  app: FastifyInstance,
  { store, guards, redis, apiKey }: AssistantRouteOptions,
): void {
  // Credits meter the cost; this meters the rate. A user with a large balance should still not be
  // able to open fifty concurrent conversations against one API key.
  const perAccount = new RedisRateLimiter(redis, 20, 60 * 1000, 'assistant');

  app.get('/assistant/status', async (_request, reply) =>
    reply.send({ configured: Boolean(apiKey) }),
  );

  /** What the account has, and what a question would cost, for the panel to show before asking. */
  app.get('/credits', async (request, reply) => {
    const user = await guards.requireUser(request, reply);
    if (!user) return reply;
    return reply.send({
      balance: await store.credits.balance(user.id),
      history: await store.credits.history(user.id, 25),
    });
  });

  app.post<{ Body: ChatBody }>('/assistant/chat', async (request, reply) => {
    // A seat, not merely an account: the assistant is part of the tool, and the tool is rationed.
    const user = await guards.requireSeat(request, reply);
    if (!user) return reply;

    // Shape first, configuration second. A malformed request is malformed whether or not there is
    // an API key, and telling someone their request is fine when it is not -- because a different
    // problem was noticed first -- means they fix the wrong thing.
    const body = request.body ?? {};
    const question = (body.question ?? '').trim();
    if (!question) return reply.status(400).send({ error: 'Ask something.' });
    if (question.length > MAX_QUESTION_CHARS) {
      return reply
        .status(413)
        .send({ error: `Questions are limited to ${MAX_QUESTION_CHARS} characters.` });
    }
    if (!body.workspace?.project) {
      return reply.status(400).send({ error: 'The workspace is missing from the request.' });
    }

    if (!apiKey) {
      return reply.status(503).send({
        error:
          'The assistant is not configured. Set GEMINI_API_KEY in the service environment and ' +
          'restart it.',
      });
    }

    const limit = await perAccount.check(user.id);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('Retry-After', limit.retryAfter)
        .send({ error: `Slow down a moment — try again in ${limit.retryAfter}s.` });
    }

    // Ask answers, Agent proposes edits. Anything else is treated as Ask: a client sending a mode
    // this server does not know should get the safe one, not an error.
    const mode: AssistantMode = body.mode === 'agent' ? 'agent' : 'ask';

    const outline = {
      question,
      history: (body.history ?? []).slice(-MAX_HISTORY),
      workspace: body.workspace,
      mode,
    };

    // Held before the call and settled after it. The estimate assumes the longest answer the model
    // is allowed to give, so it is always at or above the real cost and the difference comes back.
    const estimate = estimateChatCredits(outline);
    let hold;
    try {
      hold = await store.credits.hold(user.id, estimate, {
        reason: question.slice(0, 120),
        feature: 'chat',
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: `That question needs ${error.required} credits and you have ${error.available}.`,
          balance: await store.credits.balance(user.id),
          required: error.required,
        });
      }
      throw error;
    }

    try {
      const reply_ = await ask({ apiKey, ...outline });
      const balance = await store.credits.settle(hold, reply_.credits, {
        reason: question.slice(0, 120),
        metadata: { model: reply_.model, tokensIn: reply_.usage.input, tokensOut: reply_.usage.output },
      });

      return reply.send({
        answer: reply_.answer,
        plan: reply_.plan,
        credits: reply_.credits,
        balance,
      });
    } catch (error) {
      // Every failure path gives the hold back. A hold that leaks is credits gone with nothing in
      // the ledger to say where.
      await store.credits.release(hold, 'Assistant failed').catch(() => undefined);

      if (error instanceof AssistantError) {
        request.log.warn({ err: error }, 'assistant failed');
        return reply.status(502).send({ error: error.message });
      }
      throw error;
    }
  });
}
