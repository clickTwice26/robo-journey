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
import { createServer } from '../src/server.js';

const PASSWORD = 'correct horse battery staple';

/** A fresh server on an in-memory database per test. */
function server() {
  return createServer(undefined, ':memory:');
}

const servers: ReturnType<typeof server>[] = [];
function freshServer() {
  const app = server();
  servers.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

/** Register and return the session cookie the browser would hold. */
async function registerUser(app: ReturnType<typeof server>, email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Test' },
  });
  expect(response.statusCode).toBe(201);
  const cookie = response.headers['set-cookie'];
  const raw = Array.isArray(cookie) ? cookie[0]! : String(cookie);
  return { cookie: raw.split(';')[0]!, raw, body: response.json() };
}

describe('registration', () => {
  it('creates an account and signs the user straight in', async () => {
    const app = freshServer();
    const { body, cookie } = await registerUser(app, 'ada@example.com');
    expect(body.user.email).toBe('ada@example.com');
    expect(cookie).toContain('rj_session=');
  });

  it('never returns a password or a hash', async () => {
    const app = freshServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
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
    const app = freshServer();
    const { raw } = await registerUser(app, 'ada@example.com');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  it('refuses a weak password with a 400', async () => {
    const app = freshServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'ada@example.com', password: 'short', displayName: 'Ada' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/at least/);
  });

  it('refuses a duplicate address with a 409', async () => {
    const app = freshServer();
    await registerUser(app, 'ada@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(response.statusCode).toBe(409);
  });

  it('requires both fields', async () => {
    const app = freshServer();
    const response = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@b.co' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('login', () => {
  it('accepts the right password', async () => {
    const app = freshServer();
    await registerUser(app, 'ada@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe('ada@example.com');
  });

  it('rejects the wrong password with the same message as a missing account', async () => {
    // Different responses would let anyone enumerate registered addresses.
    const app = freshServer();
    await registerUser(app, 'ada@example.com');

    const wrong = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ada@example.com', password: 'wrong password here' },
    });
    const missing = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });

    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json().error).toBe(missing.json().error);
  });

  it('rate-limits repeated guesses at one account', async () => {
    const app = freshServer();
    await registerUser(app, 'target@example.com');

    let sawLimit = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await app.inject({
        method: 'POST', url: '/auth/login',
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

describe('sessions', () => {
  it('reports nobody when there is no cookie', async () => {
    const app = freshServer();
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).json().user).toBeNull();
  });

  it('reports the user when the cookie is present', async () => {
    const app = freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(response.json().user.email).toBe('ada@example.com');
  });

  it('ignores a forged cookie', async () => {
    const app = freshServer();
    const response = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { cookie: 'rj_session=not-a-real-token-at-all' },
    });
    expect(response.json().user).toBeNull();
  });

  it('invalidates the session on logout', async () => {
    const app = freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });

    // The old token must be dead server-side, not merely cleared in the browser.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(after.json().user).toBeNull();
  });
});

describe('projects', () => {
  it('refuses everything without a session', async () => {
    const app = freshServer();
    for (const [method, url] of [
      ['GET', '/projects'],
      ['POST', '/projects'],
      ['GET', '/projects/anything'],
      ['PUT', '/projects/anything'],
      ['DELETE', '/projects/anything'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('stores and returns a project', async () => {
    const app = freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');

    const created = await app.inject({
      method: 'POST', url: '/projects', headers: { cookie },
      payload: { name: 'Blink', document: { version: 1, parts: [] } },
    });
    expect(created.statusCode).toBe(201);

    const id = created.json().project.id;
    const fetched = await app.inject({ method: 'GET', url: `/projects/${id}`, headers: { cookie } });
    expect(JSON.parse(fetched.json().project.document).version).toBe(1);
  });

  it('does not let one user reach another projects', async () => {
    // The property that matters most in the whole file.
    const app = freshServer();
    const ada = await registerUser(app, 'ada@example.com');
    const bob = await registerUser(app, 'bob@example.com');

    const created = await app.inject({
      method: 'POST', url: '/projects', headers: { cookie: ada.cookie },
      payload: { name: 'Ada private', document: { version: 1 } },
    });
    const id = created.json().project.id;

    expect((await app.inject({ method: 'GET', url: `/projects/${id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/projects/${id}`, headers: { cookie: bob.cookie }, payload: { name: 'x', document: {} } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/projects/${id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);

    // And Ada's project is untouched.
    const still = await app.inject({ method: 'GET', url: `/projects/${id}`, headers: { cookie: ada.cookie } });
    expect(still.json().project.name).toBe('Ada private');
  });

  it('keeps each users list to themselves', async () => {
    const app = freshServer();
    const ada = await registerUser(app, 'ada@example.com');
    const bob = await registerUser(app, 'bob@example.com');

    await app.inject({ method: 'POST', url: '/projects', headers: { cookie: ada.cookie }, payload: { name: 'Ada one', document: {} } });
    await app.inject({ method: 'POST', url: '/projects', headers: { cookie: bob.cookie }, payload: { name: 'Bob one', document: {} } });

    const list = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: ada.cookie } });
    expect(list.json().projects.map((p: { name: string }) => p.name)).toEqual(['Ada one']);
  });

  it('updates a project', async () => {
    const app = freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const created = await app.inject({
      method: 'POST', url: '/projects', headers: { cookie },
      payload: { name: 'One', document: { version: 1 } },
    });
    const id = created.json().project.id;

    const updated = await app.inject({
      method: 'PUT', url: `/projects/${id}`, headers: { cookie },
      payload: { name: 'Renamed', document: { version: 1, parts: [1] } },
    });
    expect(updated.json().project.name).toBe('Renamed');
  });

  it('deletes a project', async () => {
    const app = freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const created = await app.inject({
      method: 'POST', url: '/projects', headers: { cookie }, payload: { name: 'Doomed', document: {} },
    });
    const id = created.json().project.id;

    expect((await app.inject({ method: 'DELETE', url: `/projects/${id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/projects/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('refuses a document too large to store', async () => {
    const app = freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    const response = await app.inject({
      method: 'POST', url: '/projects', headers: { cookie },
      payload: { name: 'Huge', document: { blob: 'x'.repeat(5 * 1024 * 1024) } },
    });
    expect(response.statusCode).toBe(413);
  });
});
