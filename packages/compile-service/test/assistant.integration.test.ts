/**
 * The assistant, and what it costs.
 *
 * The model call itself is not exercised here -- that needs a real API key and is covered by the
 * live suite. What is exercised is everything around it, which is where the failures that matter
 * live: a question answered without paying for it, a hold that leaks when the call fails, an empty
 * account running an expensive call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllTestServers, hasDatabase, startTestServer, type TestServer } from './harness.js';

const PASSWORD = 'correct horse battery staple';
const describeWithDb = hasDatabase() ? describe : describe.skip;

afterEach(async () => closeAllTestServers());

const WORKSPACE = {
  project: {
    version: 1,
    name: 'Blink',
    parts: [
      { id: 'uno1', type: 'arduino-uno', x: 0, y: 0, props: {} },
      { id: 'led1', type: 'led', x: 40, y: 20, props: {} },
    ],
    wires: [{ id: 'w1', from: 'uno1:D13', to: 'led1:anode', color: '#c0392b' }],
    sketch: [{ name: 'sketch.ino', contents: 'void setup(){}\nvoid loop(){}' }],
  },
  faults: [
    {
      code: 'pin-over-current',
      severity: 'error',
      subject: 'D13',
      message: 'D13 is passing 93.3 mA, beyond the 40.0 mA absolute maximum for an I/O pin.',
    },
  ],
};

async function signedIn(server: TestServer, email = 'ada@example.com') {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Ada' },
  });
  return String(response.headers['set-cookie']).split(';')[0]!;
}

const askQuestion = (server: TestServer, cookie: string, question = 'Why is my LED not lighting?') =>
  server.app.inject({
    method: 'POST',
    url: '/api/assistant/chat',
    headers: { cookie },
    payload: { question, workspace: WORKSPACE },
  });

describeWithDb('the assistant', () => {
  it('needs a seat, not merely an account', async () => {
    // It is part of the tool, and the tool is what the queue rations.
    const server = await startTestServer('assistant', { capacity: 1 });
    await signedIn(server, 'holder@example.com');
    const waiting = await signedIn(server, 'waiting@example.com');

    const response = await askQuestion(server, waiting);
    expect(response.statusCode).toBe(403);
  });

  it('reports itself unavailable rather than failing oddly when unconfigured', async () => {
    // The suite runs without an API key, which is the same state a deployment is in before one is
    // set -- and 503 with an explanation beats a 500 from inside the model client.
    const server = await startTestServer('assistant');
    const cookie = await signedIn(server);

    const status = await server.app.inject({ method: 'GET', url: '/api/assistant/status' });
    expect(status.json().configured).toBe(false);

    const response = await askQuestion(server, cookie);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/GEMINI_API_KEY/);
  });

  it('charges nothing when it could not answer', async () => {
    // The hold has to come back on every failure path. One that leaks is credits gone with nothing
    // in the ledger to say where.
    const server = await startTestServer('assistant');
    const cookie = await signedIn(server);
    const me = await server.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const before = me.json().credits.available;

    await askQuestion(server, cookie);

    const after = await server.app.inject({ method: 'GET', url: '/api/credits', headers: { cookie } });
    expect(after.json().balance.available).toBe(before);
    expect(after.json().balance.held).toBe(0);
  });

  it('refuses an empty question before spending anything', async () => {
    const server = await startTestServer('assistant');
    const cookie = await signedIn(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      headers: { cookie },
      payload: { question: '   ', workspace: WORKSPACE },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a question with no workspace', async () => {
    // Answering without one is the generic advice the assistant exists not to give.
    const server = await startTestServer('assistant');
    const cookie = await signedIn(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      headers: { cookie },
      payload: { question: 'Why is my LED not lighting?' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describeWithDb('credits', () => {
  it('come with a confirmed account', async () => {
    const server = await startTestServer('assistant-credits');
    const cookie = await signedIn(server);

    const response = await server.app.inject({ method: 'GET', url: '/api/credits', headers: { cookie } });
    expect(response.json().balance.available).toBeGreaterThan(0);
    expect(response.json().history[0].kind).toBe('grant');
  });

  it('are granted once, however many times verification runs', async () => {
    // A retried request or a second click on the link must not be a second allowance.
    const server = await startTestServer('assistant-credits-once', { requireVerifiedEmail: true });
    const cookie = await signedIn(server, 'ada@example.com');
    const token = server.linkToken('verify');

    await server.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } });
    const first = await server.app.inject({ method: 'GET', url: '/api/credits', headers: { cookie } });

    // Verifying again with a fresh link.
    await server.app.inject({ method: 'POST', url: '/api/auth/resend-verification', headers: { cookie } });
    await server.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { token: server.linkToken('verify') },
    });
    const second = await server.app.inject({ method: 'GET', url: '/api/credits', headers: { cookie } });

    expect(second.json().balance.available).toBe(first.json().balance.available);
    expect(second.json().history.filter((e: { kind: string }) => e.kind === 'grant')).toHaveLength(1);
  });

  it('are not handed to an unconfirmed address', async () => {
    // Accounts are free. An allowance given before confirmation is an allowance given to anybody
    // who can type an address, which is the thing verification exists to stop.
    const server = await startTestServer('assistant-credits-unverified', { requireVerifiedEmail: true });
    const cookie = await signedIn(server);

    const response = await server.app.inject({ method: 'GET', url: '/api/credits', headers: { cookie } });
    expect(response.json().balance.available).toBe(0);
  });

  it('needs an account to read', async () => {
    const server = await startTestServer('assistant-credits-anon');
    expect((await server.app.inject({ method: 'GET', url: '/api/credits' })).statusCode).toBe(401);
  });
});
