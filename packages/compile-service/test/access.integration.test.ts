/**
 * The queue, over HTTP.
 *
 * The store's own tests cover the rules; these cover the wiring -- that signing in is what puts
 * someone in line, that the tool itself is closed to anyone without a seat, and that the one thing
 * which must stay open through a cooldown does stay open.
 *
 * Capacity is set to two here. Ten is the policy; two is enough to make a queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeAllTestServers, hasDatabase, startTestServer } from './harness.js';

const PASSWORD = 'correct horse battery staple';

const describeWithDb = hasDatabase() ? describe : describe.skip;

/** A server with a small capacity and a controllable clock. Two seats is enough to make a queue. */
async function freshServer(
  overrides: { capacity?: number; sessionMinutes?: number; cooldownMinutes?: number } = {},
) {
  const server = await startTestServer('access-integration', {
    capacity: overrides.capacity ?? 2,
    ...(overrides.sessionMinutes !== undefined ? { sessionMinutes: overrides.sessionMinutes } : {}),
    ...(overrides.cooldownMinutes !== undefined
      ? { cooldownMinutes: overrides.cooldownMinutes }
      : {}),
  });
  return { app: server.app, clock: server.clock };
}

afterEach(async () => closeAllTestServers());

type App = FastifyInstance;

async function registerUser(app: App, email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Test' },
  });
  const cookie = response.headers['set-cookie'];
  const raw = Array.isArray(cookie) ? cookie[0]! : String(cookie);
  return { cookie: raw.split(';')[0]!, body: response.json(), status: response.statusCode };
}

const heartbeat = (app: App, cookie: string, present = true) =>
  app.inject({ method: 'POST', url: '/api/access/heartbeat', headers: { cookie }, payload: { present } });

describeWithDb('signing in', () => {
  it('puts you straight into a seat when there is room', async () => {
    const { app } = await freshServer();
    const { body } = await registerUser(app, 'ada@example.com');
    expect(body.access.state).toBe('active');
  });

  it('puts you in the queue when there is not', async () => {
    // No separate button: signing in is asking for a seat, which is what "you will face a queue"
    // means from the user's side.
    const { app } = await freshServer();
    await registerUser(app, 'a@example.com');
    await registerUser(app, 'b@example.com');

    const { body } = await registerUser(app, 'c@example.com');
    expect(body.access.state).toBe('queued');
    expect(body.access.position).toBe(1);
  });

  it('reports where you stand alongside who you are', async () => {
    const { app } = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const body = me.json();
    expect(body.user.email).toBe('ada@example.com');
    expect(body.access.state).toBe('active');
    expect(body.access.expiresAt).toBeTruthy();
  });

  it('keeps the seat count and the wait to itself', async () => {
    // Not merely absent from the interface -- absent from the wire, so there is nothing to read
    // out of a network tab and nothing to work a return time out from.
    const { app } = await freshServer({ capacity: 1 });
    await registerUser(app, 'a@example.com');
    const { body } = await registerUser(app, 'b@example.com');

    expect(body.access.state).toBe('queued');
    expect(body.access).not.toHaveProperty('capacity');
    expect(body.access).not.toHaveProperty('active');
    expect(body.access).not.toHaveProperty('estimatedWaitMs');

    // And the endpoint that used to publish it is gone.
    expect((await app.inject({ method: 'GET', url: '/api/access/occupancy' })).statusCode).toBe(404);
  });

  it('logging in again during a cooldown succeeds and says how long is left', async () => {
    const { app, clock } = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    clock.now += 60 * 60 * 1000;
    await heartbeat(app, cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().access.state).toBe('cooldown');
    expect(response.json().access.cooldownUntil).toBeTruthy();
  });
});

describeWithDb('the tool itself', () => {
  it('is closed to anyone not signed in', async () => {
    const { app } = await freshServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/compile',
      payload: { files: [{ name: 'sketch.ino', contents: 'void setup(){}void loop(){}' }] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('is closed to someone still in the queue', async () => {
    const { app } = await freshServer({ capacity: 1 });
    await registerUser(app, 'a@example.com');
    const { cookie } = await registerUser(app, 'b@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { cookie },
      payload: { files: [{ name: 'sketch.ino', contents: 'void setup(){}void loop(){}' }] },
    });
    expect(response.statusCode).toBe(403);
    // The status travels with the refusal, so the client can show the queue without asking again.
    expect(response.json().access.state).toBe('queued');
  });

  it('is closed to someone whose hour has run out', async () => {
    const { app, clock } = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    clock.now += 60 * 60 * 1000;

    const response = await app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { cookie },
      payload: { files: [{ name: 'sketch.ino', contents: 'void setup(){}void loop(){}' }] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().access.state).toBe('cooldown');
  });

  it('closes datasheet extraction the same way', async () => {
    const { app, clock } = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    clock.now += 60 * 60 * 1000;

    const response = await app.inject({
      method: 'POST',
      url: '/api/datasheet/extract',
      headers: { cookie },
      payload: { text: 'x'.repeat(200) },
    });
    expect(response.statusCode).toBe(403);
  });
});

describeWithDb('storage', () => {
  it('stays reachable after the hour ends', async () => {
    // Deliberate. Someone's time running out must not take their unsaved circuit with it, so the
    // seat gates the simulator and not the place their work is kept.
    const { app, clock } = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    clock.now += 60 * 60 * 1000;

    const save = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Half-finished', document: { version: 1, parts: [], wires: [] } },
    });
    expect(save.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(list.json().projects).toHaveLength(1);
  });
});

describeWithDb('a seat has to be used', () => {
  it('passes it on to whoever is waiting', async () => {
    const { app, clock } = await freshServer({ capacity: 1 });
    const holder = await registerUser(app, 'a@example.com');
    const waiter = await registerUser(app, 'b@example.com');
    expect(waiter.body.access.state).toBe('queued');

    // The holder leaves the tab open in the background; the waiter stays at the keyboard.
    for (let t = 0; t < 3; t++) {
      clock.now += 60 * 1000;
      await heartbeat(app, holder.cookie, false);
      await heartbeat(app, waiter.cookie, true);
    }

    expect((await heartbeat(app, waiter.cookie)).json().access.state).toBe('active');
    const bumped = (await heartbeat(app, holder.cookie)).json().access;
    expect(bumped.state).toBe('queued');
    // Told why, and told the time is not lost -- otherwise coming back to a queue screen with no
    // explanation looks like the tool logging them out at random.
    expect(bumped.lastReason).toBe('idle');
    expect(bumped.carriedMs).toBeGreaterThan(50 * 60 * 1000);
  });

  it('keeps working for someone who is actually there', async () => {
    const { app, clock } = await freshServer({ capacity: 1 });
    const holder = await registerUser(app, 'a@example.com');
    await registerUser(app, 'b@example.com');

    for (let t = 0; t < 5; t++) {
      clock.now += 60 * 1000;
      await heartbeat(app, holder.cookie, true);
    }
    expect((await heartbeat(app, holder.cookie)).json().access.state).toBe('active');
  });
});

describeWithDb('the queue', () => {
  it('lets you know the moment a seat frees', async () => {
    const { app, clock } = await freshServer({ capacity: 1 });
    const first = await registerUser(app, 'a@example.com');
    const second = await registerUser(app, 'b@example.com');
    expect(second.body.access.state).toBe('queued');

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: first.cookie } });

    // The heartbeat the client is already sending is what tells it, so there is nothing else to
    // poll and no window where the seat is free but unclaimed.
    const beat = await heartbeat(app, second.cookie);
    expect(beat.json().access.state).toBe('active');
    expect(clock.now).toBeGreaterThan(0);
  });

  it('gives the seat back when someone signs out', async () => {
    const { app } = await freshServer({ capacity: 1 });
    const holder = await registerUser(app, 'a@example.com');
    const waiter = await registerUser(app, 'b@example.com');
    expect(waiter.body.access.state).toBe('queued');

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: holder.cookie } });
    expect((await heartbeat(app, waiter.cookie)).json().access.state).toBe('active');
  });

  it('refuses to re-queue during a cooldown, and says when it ends', async () => {
    const { app, clock } = await freshServer();
    const { cookie } = await registerUser(app, 'ada@example.com');
    clock.now += 60 * 60 * 1000;
    await heartbeat(app, cookie);

    const response = await app.inject({ method: 'POST', url: '/api/access', headers: { cookie } });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeTruthy();
    expect(response.json().access.cooldownUntil).toBeTruthy();
  });

  it('needs an account for anything but the occupancy count', async () => {
    const { app } = await freshServer();
    for (const [method, url] of [
      ['GET', '/api/access'],
      ['POST', '/api/access'],
      ['POST', '/api/access/heartbeat'],
      ['POST', '/api/access/release'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
