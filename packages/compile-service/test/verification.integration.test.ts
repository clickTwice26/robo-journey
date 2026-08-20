/**
 * Confirming an address, and resetting a password.
 *
 * Verification is not a formality here: accounts are free, so the per-account cooldown is only a
 * limit if an account costs something to make, and a mailbox is that cost. Without it anyone
 * wanting a permanent seat registers ten accounts. So the assertions that matter are the ones
 * about what an unverified account *cannot* do.
 *
 * Password reset comes with it because it shares the same machinery, and because verification
 * without recovery means the first forgotten password is a permanently lost account.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeAllTestServers, hasDatabase, startTestServer, type TestServer } from './harness.js';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different long enough password';

const describeWithDb = hasDatabase() ? describe : describe.skip;

afterEach(async () => closeAllTestServers());

async function verifyingServer(): Promise<TestServer> {
  return startTestServer('verification', { capacity: 4, requireVerifiedEmail: true });
}

async function registerUser(app: FastifyInstance, email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Test' },
  });
  const raw = String(response.headers['set-cookie']);
  return { cookie: raw.split(';')[0]!, body: response.json(), status: response.statusCode };
}

const post = (app: FastifyInstance, url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, ...(cookie ? { headers: { cookie } } : {}), ...(payload ? { payload } : {}) });

describeWithDb('signing up', () => {
  it('sends a confirmation link', async () => {
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');

    expect(server.mailer.sent).toHaveLength(1);
    expect(server.mailer.sent[0]!.to).toBe('ada@example.com');
    expect(server.mailer.sent[0]!.subject).toMatch(/confirm/i);
    expect(server.linkToken('verify')).toBeTruthy();
  });

  it('creates the account signed in but unconfirmed', async () => {
    // Signed in, so there is somewhere to tell them what to do next -- but not verified, so there
    // is nothing they can do with it yet.
    const server = await verifyingServer();
    const { body, status } = await registerUser(server.app, 'ada@example.com');

    expect(status).toBe(201);
    expect(body.user.emailVerified).toBe(false);
    expect(body.access.state).toBe('idle');
  });

  it('refuses a seat until the address is confirmed', async () => {
    // The whole point. A free account that can take a seat makes the cooldown meaningless.
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');

    const response = await post(server.app, '/api/access', cookie);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/confirm/i);
  });

  it('refuses the tool itself too', async () => {
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { cookie },
      payload: { files: [{ name: 'sketch.ino', contents: 'void setup(){}void loop(){}' }] },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not put an unconfirmed account in the queue', async () => {
    // Holding a place in a line it cannot reach the front of would be worse than being told why.
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');

    const me = await server.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().access.state).toBe('idle');
    expect(me.json().access.waiting).toBe(0);
  });
});

describeWithDb('confirming', () => {
  it('lets the account in', async () => {
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');

    const response = await post(server.app, '/api/auth/verify', cookie, {
      token: server.linkToken('verify'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.emailVerified).toBe(true);
    // Confirmed in the browser that already held the session, so they go straight to a seat.
    expect(response.json().access.state).toBe('active');
  });

  it('works from a browser that is not signed in', async () => {
    // The link is usually opened on a phone. The token is the proof, not the cookie.
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');

    const response = await post(server.app, '/api/auth/verify', undefined, {
      token: server.linkToken('verify'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.emailVerified).toBe(true);
    // Nobody to seat: the browser holding the link is not the browser holding the session.
    expect(response.json().access).toBeNull();
  });

  it('spends the link, so a second click says so', async () => {
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');
    const token = server.linkToken('verify');

    await post(server.app, '/api/auth/verify', cookie, { token });
    const again = await post(server.app, '/api/auth/verify', cookie, { token });

    expect(again.statusCode).toBe(400);
    // Distinct from an invented token, because the next step is different: nothing to do.
    expect(again.json().error).toMatch(/already been used/i);
  });

  it('rejects a token that was never issued', async () => {
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');

    const response = await post(server.app, '/api/auth/verify', undefined, { token: 'invented' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not valid/i);
  });

  it('supersedes the previous link when another is asked for', async () => {
    // Otherwise an inbox accumulates working links, and the oldest is the one most likely to have
    // been forwarded or left on a shared machine.
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');
    const first = server.linkToken('verify');

    await post(server.app, '/api/auth/resend-verification', cookie);
    const second = server.linkToken('verify');
    expect(second).not.toBe(first);

    expect((await post(server.app, '/api/auth/verify', cookie, { token: first })).statusCode).toBe(400);
    expect((await post(server.app, '/api/auth/verify', cookie, { token: second })).statusCode).toBe(200);
  });

  it('never puts the token in a place it could be logged', async () => {
    // It goes in the body rather than the query string: a URL ends up in access logs, proxies and
    // browser history, and this one is a credential.
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');

    const response = await server.app.inject({
      method: 'POST',
      url: `/api/auth/verify?token=${server.linkToken('verify')}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});

describeWithDb('resetting a password', () => {
  it('answers the same whether or not the address exists', async () => {
    // Anything else turns this into a way to find out who has an account.
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');

    const known = await post(server.app, '/api/auth/forgot-password', undefined, {
      email: 'ada@example.com',
    });
    const unknown = await post(server.app, '/api/auth/forgot-password', undefined, {
      email: 'nobody@example.com',
    });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());
  });

  it('only sends to an address that has one', async () => {
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');
    server.mailer.sent.length = 0;

    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'nobody@example.com' });
    expect(server.mailer.sent).toHaveLength(0);

    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'ada@example.com' });
    expect(server.mailer.sent).toHaveLength(1);
    expect(server.mailer.sent[0]!.subject).toMatch(/reset/i);
  });

  it('changes the password and signs every session out', async () => {
    // A reset means the account holder has lost control or thinks they have. Leaving whoever else
    // was signed in still signed in defeats the point of resetting.
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');
    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'ada@example.com' });

    const response = await post(server.app, '/api/auth/reset-password', undefined, {
      token: server.linkToken('reset'),
      password: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);

    const stale = await server.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(stale.json().user).toBeNull();

    const old = await post(server.app, '/api/auth/login', undefined, {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(old.statusCode).toBe(401);

    const fresh = await post(server.app, '/api/auth/login', undefined, {
      email: 'ada@example.com',
      password: NEW_PASSWORD,
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('counts as confirming the address', async () => {
    // Reaching the mailbox proves it as surely as a verification link does, and making somebody
    // who has just proved it go and prove it again would be theatre.
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');
    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'ada@example.com' });
    await post(server.app, '/api/auth/reset-password', undefined, {
      token: server.linkToken('reset'),
      password: NEW_PASSWORD,
    });

    const fresh = await post(server.app, '/api/auth/login', undefined, {
      email: 'ada@example.com',
      password: NEW_PASSWORD,
    });
    expect(fresh.json().user.emailVerified).toBe(true);
    expect(fresh.json().access.state).toBe('active');
  });

  it('refuses a weak new password without spending anything', async () => {
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');
    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'ada@example.com' });

    const response = await post(server.app, '/api/auth/reset-password', undefined, {
      token: server.linkToken('reset'),
      password: 'short',
    });
    expect(response.statusCode).toBe(400);

    // The old password still works, so nothing was half-done.
    const still = await post(server.app, '/api/auth/login', undefined, {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(still.statusCode).toBe(200);
  });

  it('will not spend a reset link twice', async () => {
    const server = await verifyingServer();
    await registerUser(server.app, 'ada@example.com');
    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'ada@example.com' });
    const token = server.linkToken('reset');

    await post(server.app, '/api/auth/reset-password', undefined, { token, password: NEW_PASSWORD });
    const again = await post(server.app, '/api/auth/reset-password', undefined, {
      token,
      password: 'yet another long password',
    });
    expect(again.statusCode).toBe(400);
  });

  it('will not verify with a reset token, or reset with a verify one', async () => {
    // The kinds have different lifetimes and different powers; one standing in for the other would
    // make a day-long verification link into a day-long password reset.
    const server = await verifyingServer();
    const { cookie } = await registerUser(server.app, 'ada@example.com');
    const verify = server.linkToken('verify');
    await post(server.app, '/api/auth/forgot-password', undefined, { email: 'ada@example.com' });
    const reset = server.linkToken('reset');

    expect((await post(server.app, '/api/auth/verify', cookie, { token: reset })).statusCode).toBe(400);
    expect(
      (await post(server.app, '/api/auth/reset-password', undefined, { token: verify, password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(400);
  });
});

describeWithDb('when verification is switched off', () => {
  it('lets an account straight in', async () => {
    // Which is how a local checkout works without a mail account, and why the config refuses to
    // start in production with verification on and no mail server.
    const server = await startTestServer('verification-off', { requireVerifiedEmail: false });
    const { body } = await registerUser(server.app, 'ada@example.com');
    expect(body.access.state).toBe('active');
  });
});
