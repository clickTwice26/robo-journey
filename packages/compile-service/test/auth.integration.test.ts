/**
 * Auth and project routes, driven through the real HTTP stack.
 *
 * Fastify's `inject` runs a request through the full pipeline -- routing, cookies, handlers --
 * without opening a port, so these test what a browser would actually get back rather than the
 * store underneath.
 *
 * The assertions are mostly about what must NOT happen: no password in a response, no cookie a
 * script can read, no reaching another user's work, no unlimited guessing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeAllTestServers, hasDatabase, startTestServer } from './harness.js';

const PASSWORD = 'correct horse battery staple';

const describeWithDb = hasDatabase() ? describe : describe.skip;

/** A server on a schema and a Redis namespace of its own. */
async function freshServer(): Promise<FastifyInstance> {
  const server = await startTestServer('auth-integration', { capacity: 20 });
  return server.app;
}

afterEach(async () => closeAllTestServers());

/** Register and return the session cookie the browser would hold. */
async function registerUser(app: FastifyInstance, email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Test' },
  });
  expect(response.statusCode).toBe(201);
  const cookie = response.headers['set-cookie'];
  const raw = Array.isArray(cookie) ? cookie[0]! : String(cookie);
  return { cookie: raw.split(';')[0]!, raw, body: response.json() };
}

describeWithDb('registration', () => {
  it('creates an account and signs the user straight in', async () => {
    const app = await freshServer();
    const { body, cookie } = await registerUser(app, 'ada@example.com');
    expect(body.user.email).toBe('ada@example.com');
    expect(cookie).toContain('rj_session=');
  });

  it('never returns a password or a hash', async () => {
    const app = await freshServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' },
    });
    const text = response.body;
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('hash');
    expect(text).not.toContain('salt');
  });

  it('sets a cookie JavaScript cannot read and another site cannot ride', async () => {
    // httpOnly stops an injected script stealing the session; sameSite=strict stops a cross-site
    // request using it.
    const app = await freshServer();
    const { raw } = await registerUser(app, 'ada@example.com');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  it('refuses a weak password with a 400', async () => {
    const app = await freshServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ada@example.com', password: 'short', displayName: 'Ada' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/at least/);
  });

  it('refuses a duplicate address with a 409', async () => {
    const app = await freshServer();
    await registerUser(app, 'ada@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(response.statusCode).toBe(409);
  });

  it('requires both fields', async () => {
    const app = await freshServer();
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@b.co' } });
    expect(response.statusCode).toBe(400);
  });
});

describeWithDb('login', () => {
  it('accepts the right password', async () => {
    const app = await freshServer();
    await registerUser(app, 'ada@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe('ada@example.com');
  });

  it('rejects the wrong password with the same message as a missing account', async () => {
    // Different responses would let anyone enumerate registered addresses.
    const app = await freshServer();
    await registerUser(app, 'ada@example.com');

    const wrong = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: 'wrong password here' },
    });
    const missing = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });

    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json().error).toBe(missing.json().error);
  });

  it('rate-limits repeated guesses at one account', async () => {
    const app = await freshServer();
    await registerUser(app, 'target@example.com');

    let sawLimit = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: 'target@example.com', password: `guess ${attempt} wrong` },
      });
      if (response.statusCode === 429) {
        sawLimit = true;
        expect(response.headers['retry-after']).toBeDefined();
        break;
      }
    }
    expect(sawLimit, 'unlimited password guessing was allowed').toBe(true);
  });
});

describeWithDb('sessions', () => {
  it('reports nobody when there is no cookie', async () => {
    const app = await freshServer();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).json().user).toBeNull();
  });

  it('reports the user when the cookie is present', async () => {
    const app = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.json().user.email).toBe('ada@example.com');
  });

  it('ignores a forged cookie', async () => {
    const app = await freshServer();
    const response = await app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { cookie: 'rj_session=not-a-real-token-at-all' },
    });
    expect(response.json().user).toBeNull();
  });

  it('invalidates the session on logout', async () => {
    const app = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });

    // The old token must be dead server-side, not merely cleared in the browser.
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.json().user).toBeNull();
  });
});

describeWithDb('projects', () => {
  it('refuses everything without a session', async () => {
    const app = await freshServer();
    for (const [method, url] of [
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['GET', '/api/projects/anything'],
      ['PUT', '/api/projects/anything'],
      ['DELETE', '/api/projects/anything'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('stores and returns a project', async () => {
    const app = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');

    const created = await app.inject({
      method: 'POST', url: '/api/projects', headers: { cookie },
      payload: { name: 'Blink', document: { version: 1, parts: [] } },
    });
    expect(created.statusCode).toBe(201);

    const id = created.json().project.id;
    const fetched = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    // JSONB, so it comes back as a value rather than a string that has to be parsed.
    expect(fetched.json().project.document).toEqual({ version: 1, parts: [] });
  });

  it('does not let one user reach another projects', async () => {
    // The property that matters most in the whole file.
    const app = await freshServer();
    const ada = await registerUser(app, 'ada@example.com');
    const bob = await registerUser(app, 'bob@example.com');

    const created = await app.inject({
      method: 'POST', url: '/api/projects', headers: { cookie: ada.cookie },
      payload: { name: 'Ada private', document: { version: 1 } },
    });
    const id = created.json().project.id;

    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${id}`, headers: { cookie: bob.cookie }, payload: { name: 'x', document: {} } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);

    // And Ada's project is untouched.
    const still = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie: ada.cookie } });
    expect(still.json().project.name).toBe('Ada private');
  });

  it('keeps each users list to themselves', async () => {
    const app = await freshServer();
    const ada = await registerUser(app, 'ada@example.com');
    const bob = await registerUser(app, 'bob@example.com');

    await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: ada.cookie }, payload: { name: 'Ada one', document: {} } });
    await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: bob.cookie }, payload: { name: 'Bob one', document: {} } });

    const list = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: ada.cookie } });
    expect(list.json().projects.map((p: { name: string }) => p.name)).toEqual(['Ada one']);
  });

  it('updates a project', async () => {
    const app = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const created = await app.inject({
      method: 'POST', url: '/api/projects', headers: { cookie },
      payload: { name: 'One', document: { version: 1 } },
    });
    const id = created.json().project.id;

    const updated = await app.inject({
      method: 'PUT', url: `/api/projects/${id}`, headers: { cookie },
      payload: { name: 'Renamed', document: { version: 1, parts: [1] } },
    });
    expect(updated.json().project.name).toBe('Renamed');
  });

  it('deletes a project', async () => {
    const app = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const created = await app.inject({
      method: 'POST', url: '/api/projects', headers: { cookie }, payload: { name: 'Doomed', document: {} },
    });
    const id = created.json().project.id;

    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('refuses a document too large to store', async () => {
    const app = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const response = await app.inject({
      method: 'POST', url: '/api/projects', headers: { cookie },
      payload: { name: 'Huge', document: { blob: 'x'.repeat(5 * 1024 * 1024) } },
    });
    expect(response.statusCode).toBe(413);
  });
});
