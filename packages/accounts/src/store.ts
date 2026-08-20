/**
 * Accounts, sessions and project storage.
 *
 * Everything security-sensitive stays on this side of the wire: password hashes and session tokens
 * are written here and never returned to a caller. Tokens in particular are stored only as a
 * SHA-256 of themselves, so a copy of this database does not hand over a set of live sessions.
 *
 * Queries are parameterised without exception. There is no string interpolation into SQL anywhere
 * in this package, which is a rule rather than a habit -- one place doing it differently is all it
 * takes.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { AccessController, type AccessConfig } from './access.js';
import { CreditStore } from './credits.js';
import {
  deserializeHash,
  hashPassword,
  serializeHash,
  verifyPassword,
  WeakPasswordError,
} from './passwords.js';

/** How long a session lasts without use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Renew a session when it is more than this old.
 *
 * Rolling expiry, so an active user is not logged out mid-session, without writing to the database
 * on every single request.
 */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export class AccountError extends Error {}
export class EmailInUseError extends AccountError {}
export class InvalidCredentialsError extends AccountError {}
export class NotFoundError extends AccountError {}

/** What a caller is allowed to see about a user. Never includes the hash. */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  /**
   * Whether the address has been proved.
   *
   * Exposed because the interface has to act on it -- an unverified account can sign in and see
   * where it stands, and cannot take a seat. Accounts are free, so without this the per-account
   * cooldown means nothing: anyone wanting a permanent seat registers ten accounts.
   */
  readonly emailVerified: boolean;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface StoredProject extends ProjectSummary {
  /** The `.rjp` document. */
  readonly document: unknown;
}

/** Normalise an address so `A@B.com` and `a@b.com` are the same account. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately permissive: the only real test of an address is whether mail reaches it. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(email: string): boolean {
  return EMAIL_SHAPE.test(email) && email.length <= 254;
}

/** Session tokens are stored hashed, so a leaked database does not hand over live sessions. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
  email_verified_at: Date | null;
}

const toUser = (row: UserRow): PublicUser => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  createdAt: iso(row.created_at),
  emailVerified: row.email_verified_at !== null,
});

export class AccountStore {
  /**
   * Who may use the simulator right now.
   *
   * Kept as its own object rather than folded in here: identity and capacity answer different
   * questions and change for different reasons, and one is enforced on every request while the
   * other is checked once at sign-in.
   */
  readonly access: AccessController;

  /** The meter on the AI features. Its own object for the same reason `access` is. */
  readonly credits: CreditStore;

  constructor(
    private readonly pool: Pool,
    accessConfig: AccessConfig = {},
  ) {
    this.access = new AccessController(pool, accessConfig);
    this.credits = new CreditStore(pool);
  }

  // --- Users -------------------------------------------------------------------------------------

  async register(email: string, password: string, displayName: string): Promise<PublicUser> {
    const normalised = normaliseEmail(email);
    if (!isPlausibleEmail(normalised)) {
      throw new AccountError('That does not look like an email address.');
    }
    const name = displayName.trim() || normalised.split('@')[0]!;
    if (name.length > 64) throw new AccountError('Display name must be under 64 characters.');

    // Enforces strength and throws WeakPasswordError, which the route surfaces as a 400 rather
    // than a 500. Done before touching the database so a weak password costs no query.
    const hash = await hashPassword(password);
    const id = randomUUID();

    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, created_at, email_verified_at`,
        [id, normalised, name, serializeHash(hash)],
      );
      return toUser(rows[0]!);
    } catch (error) {
      // The unique index is the only guard that holds: two simultaneous registrations would both
      // pass a prior existence check, and exactly one can win the insert.
      if (isUniqueViolation(error)) {
        throw new EmailInUseError('An account already exists for that address.');
      }
      throw error;
    }
  }

  /**
   * Check credentials.
   *
   * Hashes a dummy password when the account does not exist, so a missing address takes the same
   * time as a wrong password. Otherwise the response time alone reveals which addresses are
   * registered.
   */
  async authenticate(email: string, password: string): Promise<PublicUser> {
    const normalised = normaliseEmail(email);
    const { rows } = await this.pool.query<UserRow & { password_hash: string }>(
      `SELECT id, email, display_name, password_hash, created_at, email_verified_at
         FROM users WHERE lower(email) = $1`,
      [normalised],
    );
    const row = rows[0];

    if (!row) {
      await verifyPassword(password, {
        algorithm: 'scrypt',
        n: 32768,
        r: 8,
        p: 1,
        salt: Buffer.alloc(16).toString('base64'),
        hash: Buffer.alloc(64).toString('base64'),
      });
      throw new InvalidCredentialsError('Email or password is incorrect.');
    }

    const ok = await verifyPassword(password, deserializeHash(row.password_hash));
    // Deliberately the same message either way: telling the user which half was wrong tells an
    // attacker which addresses exist.
    if (!ok) throw new InvalidCredentialsError('Email or password is incorrect.');

    return toUser(row);
  }

  async findUser(id: string): Promise<PublicUser | null> {
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, email, display_name, created_at, email_verified_at FROM users WHERE id = $1',
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** Find by address, for the paths that start from one. Null rather than throwing: see below. */
  async findUserByEmail(email: string): Promise<PublicUser | null> {
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, email, display_name, created_at, email_verified_at FROM users WHERE lower(email) = $1',
      [normaliseEmail(email)],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  /**
   * Record that an address has been proved.
   *
   * Idempotent, and it keeps the first timestamp: clicking a link twice should not move the date
   * an account was verified.
   */
  async markEmailVerified(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1::uuid',
      [userId],
    );
  }

  /**
   * Set a new password.
   *
   * Every session goes with it. A reset means the account holder has lost control of it or thinks
   * they have, and leaving whoever else was signed in still signed in defeats the point of
   * resetting.
   */
  async setPassword(userId: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2::uuid', [
      serializeHash(hash),
      userId,
    ]);
    await this.destroyAllSessions(userId);
  }

  // --- Sessions ----------------------------------------------------------------------------------

  /** Start a session and return the token. The token itself is never stored, only its hash. */
  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), userId, expiresAt],
    );

    return { token, expiresAt };
  }

  /**
   * Resolve a session token to its user, renewing it if it is getting old.
   *
   * One statement rather than a lookup followed by a fetch: this runs on every authenticated
   * request, and a round trip saved here is saved everywhere. Returns null for anything expired,
   * unknown or malformed -- the caller cannot tell which, and does not need to.
   */
  async resolveSession(token: string | undefined): Promise<PublicUser | null> {
    if (!token) return null;

    const { rows } = await this.pool.query<UserRow & { expires_at: Date }>(
      `SELECT u.id, u.email, u.display_name, u.created_at, u.email_verified_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;

    // Rolling expiry: extend an actively used session, but not on every single request. The write
    // is not awaited on the read path -- the session is already known valid, and making every
    // request wait for a housekeeping update would be paying latency for nothing.
    if (row.expires_at.getTime() - Date.now() < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
      // Wrapped as well as caught: a query against a closed pool throws synchronously rather than
      // returning a rejected promise, so `.catch` alone does not contain it.
      try {
        void this.pool
          .query('UPDATE sessions SET expires_at = $1 WHERE token_hash = $2', [
            new Date(Date.now() + SESSION_TTL_MS),
            hashToken(token),
          ])
          .catch(() => {
            // A failed renewal costs the user nothing today; the session is still valid.
          });
      } catch {
        // Shutting down. Nothing to renew into.
      }
    }

    return toUser(row);
  }

  async destroySession(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  /** Sign out everywhere. What a user wants after losing a laptop. */
  async destroyAllSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  /** Housekeeping, so expired rows do not accumulate forever. */
  async pruneSessions(): Promise<number> {
    const result = await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }

  // --- Projects ----------------------------------------------------------------------------------

  async listProjects(userId: string): Promise<ProjectSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT id, name, created_at, updated_at FROM projects WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }));
  }

  /**
   * Read one project.
   *
   * Scoped by user id in the query itself rather than fetched and then checked. A missing row and
   * someone else's row are the same outcome here, which is what stops an id guess from confirming
   * that a project exists.
   */
  async getProject(userId: string, id: string): Promise<StoredProject | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      document: unknown;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT id, name, document, created_at, updated_at FROM projects WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      document: row.document,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async createProject(userId: string, name: string, document: unknown): Promise<StoredProject> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      document: unknown;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO projects (id, user_id, name, document)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, document, created_at, updated_at`,
      [randomUUID(), userId, name.trim() || 'Untitled', JSON.stringify(document)],
    );
    const row = rows[0]!;
    return {
      id: row.id,
      name: row.name,
      document: row.document,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async updateProject(
    userId: string,
    id: string,
    name: string,
    document: unknown,
  ): Promise<StoredProject> {
    if (!isUuid(id)) throw new NotFoundError('No such project.');
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      document: unknown;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE projects SET name = $1, document = $2, updated_at = now()
        WHERE id = $3 AND user_id = $4
       RETURNING id, name, document, created_at, updated_at`,
      [name.trim() || 'Untitled', JSON.stringify(document), id, userId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('No such project.');
    return {
      id: row.id,
      name: row.name,
      document: row.document,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async deleteProject(userId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw new NotFoundError('No such project.');
    const result = await this.pool.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [
      id,
      userId,
    ]);
    if ((result.rowCount ?? 0) === 0) throw new NotFoundError('No such project.');
  }

  /** Number of projects a user has, for the quota check. */
  async countProjects(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM projects WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0]!.n);
  }
}

/**
 * A UUID column rejects a malformed id with an error rather than an empty result, which would
 * surface as a 500 for what is really a 404. Checked here so a guessed id fails the same way a
 * missing one does.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/** Postgres unique-violation code, from the standard SQLSTATE list. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** Constant-time string comparison, for anything secret that is not already hashed. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export { WeakPasswordError };
