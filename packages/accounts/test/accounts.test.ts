/**
 * Accounts, sessions and project storage.
 *
 * The assertions that matter here are the security properties, not the happy path: that a hash
 * never reveals its password, that a wrong password and a missing account are indistinguishable,
 * that one user cannot reach another's projects, and that a session token is useless once revoked.
 * Those are the things that are quiet when broken.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountStore,
  EmailInUseError,
  InvalidCredentialsError,
  MIN_PASSWORD_LENGTH,
  NotFoundError,
  WeakPasswordError,
  checkPasswordStrength,
  hashPassword,
  normaliseEmail,
  verifyPassword,
} from '../src/index.js';
import { createBackends, hasDatabase, type TestBackends } from '../../../test/database.js';

const GOOD_PASSWORD = 'correct horse battery staple';

const describeWithDb = hasDatabase() ? describe : describe.skip;

/**
 * A store on a schema of its own, created per test.
 *
 * Password hashing is pure and needs no database, so those tests stay outside this and keep
 * running on a machine without Docker.
 */
let backends: TestBackends;
const store = (): AccountStore => new AccountStore(backends.pool);

function withDatabase(name: string): void {
  beforeEach(async () => {
    backends = await createBackends(name);
  });
  afterEach(async () => backends.close());
}

describe('password hashing', () => {
  it('produces a hash that does not contain the password', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(JSON.stringify(hash)).not.toContain(GOOD_PASSWORD);
    expect(JSON.stringify(hash)).not.toContain('correct');
  });

  it('verifies the right password', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword(GOOD_PASSWORD, hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Without a per-user salt, identical passwords share a hash and one cracked account exposes
    // every other user who chose the same one.
    const a = await hashPassword(GOOD_PASSWORD);
    const b = await hashPassword(GOOD_PASSWORD);
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it('stores its cost parameters, so they can be raised later', async () => {
    // A hash that does not carry its parameters cannot be verified after they change, which means
    // every user would have to reset their password to strengthen the scheme.
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(hash.n).toBeGreaterThanOrEqual(16384);
    expect(hash.algorithm).toBe('scrypt');
  });

  it('rejects a password shorter than the minimum', () => {
    expect(() => checkPasswordStrength('short')).toThrow(WeakPasswordError);
    expect(() => checkPasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(WeakPasswordError);
    expect(() => checkPasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('rejects passwords that are famously common', () => {
    expect(() => checkPasswordStrength('password123')).toThrow(/commonly used/);
  });

  it('caps the length, so a huge password cannot be used to burn CPU', () => {
    expect(() => checkPasswordStrength('x'.repeat(10_000))).toThrow(WeakPasswordError);
  });
});

describeWithDb('registration', () => {
  withDatabase('accounts-registration');

  it('creates an account and never returns the hash', async () => {
    const db = store();
    const user = await db.register('Ada@Example.com', GOOD_PASSWORD, 'Ada');
    expect(user.email).toBe('ada@example.com');
    expect(user.displayName).toBe('Ada');
    expect(JSON.stringify(user)).not.toContain('hash');
    expect(JSON.stringify(user)).not.toContain(GOOD_PASSWORD);
  });

  it('treats addresses case-insensitively', async () => {
    const db = store();
    await db.register('ada@example.com', GOOD_PASSWORD, 'Ada');
    await expect(db.register('ADA@EXAMPLE.COM', GOOD_PASSWORD, 'Ada')).rejects.toThrow(EmailInUseError);
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('refuses a second account on the same address', async () => {
    const db = store();
    await db.register('ada@example.com', GOOD_PASSWORD, 'Ada');
    await expect(db.register('ada@example.com', GOOD_PASSWORD, 'Other')).rejects.toThrow(EmailInUseError);
  });

  it('refuses an implausible address', async () => {
    const db = store();
    await expect(db.register('not-an-email', GOOD_PASSWORD, 'X')).rejects.toThrow(/email address/);
  });

  it('refuses a weak password before creating anything', async () => {
    const db = store();
    await expect(db.register('ada@example.com', 'short', 'Ada')).rejects.toThrow(WeakPasswordError);
    // And leaves no account behind.
    await expect(db.authenticate('ada@example.com', 'short')).rejects.toThrow(InvalidCredentialsError);
  });

  it('falls back to the address for a blank display name', async () => {
    const db = store();
    expect((await db.register('ada@example.com', GOOD_PASSWORD, '   ')).displayName).toBe('ada');
  });
});

describeWithDb('authentication', () => {
  withDatabase('accounts-authentication');

  it('accepts the right credentials', async () => {
    const db = store();
    const created = await db.register('ada@example.com', GOOD_PASSWORD, 'Ada');
    expect((await db.authenticate('ada@example.com', GOOD_PASSWORD)).id).toBe(created.id);
  });

  it('gives the same error for a wrong password and a missing account', async () => {
    // Different messages would let anyone enumerate which addresses are registered.
    const db = store();
    await db.register('ada@example.com', GOOD_PASSWORD, 'Ada');

    const wrongPassword = await db
      .authenticate('ada@example.com', 'wrong password here')
      .catch((error: unknown) => error);
    const noAccount = await db
      .authenticate('nobody@example.com', GOOD_PASSWORD)
      .catch((error: unknown) => error);

    expect(wrongPassword).toBeInstanceOf(InvalidCredentialsError);
    expect(noAccount).toBeInstanceOf(InvalidCredentialsError);
    expect((wrongPassword as Error).message).toBe((noAccount as Error).message);
  });
});

describeWithDb('sessions', () => {
  withDatabase('accounts-sessions');

  async function signedIn() {
    const db = store();
    const user = await db.register('ada@example.com', GOOD_PASSWORD, 'Ada');
    const session = await db.createSession(user.id);
    return { db, user, session };
  }

  it('resolves a token to its user', async () => {
    const { db, user, session } = await signedIn();
    expect((await db.resolveSession(session.token))?.id).toBe(user.id);
  });

  it('rejects an unknown or absent token', async () => {
    const { db } = await signedIn();
    expect(await db.resolveSession('not-a-real-token')).toBeNull();
    expect(await db.resolveSession(undefined)).toBeNull();
    expect(await db.resolveSession('')).toBeNull();
  });

  it('stops working once destroyed', async () => {
    const { db, session } = await signedIn();
    await db.destroySession(session.token);
    expect(await db.resolveSession(session.token)).toBeNull();
  });

  it('signs out everywhere when asked', async () => {
    // What a user wants after losing a laptop.
    const { db, user } = await signedIn();
    const a = await db.createSession(user.id);
    const b = await db.createSession(user.id);

    await db.destroyAllSessions(user.id);
    expect(await db.resolveSession(a.token)).toBeNull();
    expect(await db.resolveSession(b.token)).toBeNull();
  });

  it('issues a different token every time', async () => {
    const { db, user } = await signedIn();
    const issued = await Promise.all(
      Array.from({ length: 20 }, async () => (await db.createSession(user.id)).token),
    );
    const tokens = new Set(issued);
    expect(tokens.size).toBe(20);
  });

  it('issues tokens long enough to be unguessable', async () => {
    const { session } = await signedIn();
    // 32 random bytes, base64url encoded.
    expect(session.token.length).toBeGreaterThanOrEqual(40);
  });

  it('expires', async () => {
    const { db, user } = await signedIn();
    const session = await db.createSession(user.id);
    // Age it directly rather than waiting thirty days. The pool is the seam now, so this needs
    // no reaching into anything private.
    await backends.pool.query('UPDATE sessions SET expires_at = now() - interval \'1 second\'');

    expect(await db.resolveSession(session.token)).toBeNull();
  });

  it('prunes expired sessions', async () => {
    const { db, user } = await signedIn();
    await db.createSession(user.id);
    await backends.pool.query('UPDATE sessions SET expires_at = now() - interval \'1 second\'');
    expect(await db.pruneSessions()).toBeGreaterThan(0);
  });
});

describeWithDb('projects', () => {
  withDatabase('accounts-projects');

  async function twoUsers() {
    const db = store();
    const ada = await db.register('ada@example.com', GOOD_PASSWORD, 'Ada');
    const bob = await db.register('bob@example.com', GOOD_PASSWORD, 'Bob');
    return { db, ada, bob };
  }

  it('stores and returns a project', async () => {
    const { db, ada } = await twoUsers();
    const created = await db.createProject(ada.id, 'Blink', { version: 1 });
    // Stored as JSONB and returned as a value, not as the string it was encoded into. A column of
    // text holding JSON is queryable by nothing; this one is.
    expect((await db.getProject(ada.id, created.id))?.document).toEqual({ version: 1 });
  });

  it('lists a user projects, most recently updated first', async () => {
    const { db, ada } = await twoUsers();
    const first = await db.createProject(ada.id, 'One', {});
    await db.createProject(ada.id, 'Two', {});
    await db.updateProject(ada.id, first.id, 'One', { changed: true });

    expect((await db.listProjects(ada.id)).map((p) => p.name)).toEqual(['One', 'Two']);
  });

  it('does not let one user read another projects', async () => {
    // The property that matters most. Scoped in the query rather than fetched and then checked,
    // so there is no path where the check can be skipped.
    const { db, ada, bob } = await twoUsers();
    const secret = await db.createProject(ada.id, 'Ada private work', {});
    expect(await db.getProject(bob.id, secret.id)).toBeNull();
  });

  it('does not let one user update another project', async () => {
    const { db, ada, bob } = await twoUsers();
    const secret = await db.createProject(ada.id, 'Ada', {});
    await expect(db.updateProject(bob.id, secret.id, 'Hijacked', {})).rejects.toThrow(NotFoundError);
    expect((await db.getProject(ada.id, secret.id))?.name).toBe('Ada');
  });

  it('does not let one user delete another project', async () => {
    const { db, ada, bob } = await twoUsers();
    const secret = await db.createProject(ada.id, 'Ada', {});
    await expect(db.deleteProject(bob.id, secret.id)).rejects.toThrow(NotFoundError);
    expect(await db.getProject(ada.id, secret.id)).not.toBeNull();
  });

  it('keeps each user list to themselves', async () => {
    const { db, ada, bob } = await twoUsers();
    await db.createProject(ada.id, 'Ada one', {});
    await db.createProject(bob.id, 'Bob one', {});
    expect((await db.listProjects(ada.id)).map((p) => p.name)).toEqual(['Ada one']);
    expect((await db.listProjects(bob.id)).map((p) => p.name)).toEqual(['Bob one']);
  });

  it('deletes a users projects along with the account', async () => {
    const { db, ada } = await twoUsers();
    await db.createProject(ada.id, 'Doomed', {});
    await backends.pool.query('DELETE FROM users WHERE id = $1', [ada.id]);
    // The foreign key cascade must actually be on, or orphaned rows accumulate forever.
    expect(await db.listProjects(ada.id)).toEqual([]);
  });

  it('reports a missing project rather than inventing one', async () => {
    const { db, ada } = await twoUsers();
    expect(await db.getProject(ada.id, 'no-such-id')).toBeNull();
    await expect(db.deleteProject(ada.id, 'no-such-id')).rejects.toThrow(NotFoundError);
  });

  it('counts projects for the quota check', async () => {
    const { db, ada } = await twoUsers();
    expect(await db.countProjects(ada.id)).toBe(0);
    await db.createProject(ada.id, 'One', {});
    expect(await db.countProjects(ada.id)).toBe(1);
  });
});
