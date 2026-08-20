/**
 * Accounts and project storage.
 *
 * SQLite through `node:sqlite`, which ships with Node -- no native build step, no service to run,
 * and the whole database is one file the user can back up or delete. For a tool that runs on a
 * developer's own machine that is the right trade against a server-class database.
 *
 * Everything security-sensitive stays on this side of the wire: password hashes and session
 * tokens are written here and never returned to a caller.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessController, type AccessConfig } from './access.js';
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
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface StoredProject extends ProjectSummary {
  /** The `.rjp` document, as JSON text. */
  readonly document: string;
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

export class AccountStore {
  private readonly db: DatabaseSync;

  /**
   * Who may use the simulator right now.
   *
   * Kept as its own object rather than folded in here: identity and capacity answer different
   * questions and change for different reasons, and one is enforced on every request while the
   * other is checked once at sign-in.
   */
  readonly access: AccessController;

  constructor(filename = 'robo-journey.db', accessConfig: AccessConfig = {}) {
    this.db = new DatabaseSync(filename);
    // WAL keeps reads from blocking writes, which matters once autosave is writing continuously.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    // After `migrate`, because the access table has a foreign key into users.
    this.access = new AccessController(this.db, accessConfig);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        document   TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- Users -------------------------------------------------------------------------------------

  async register(email: string, password: string, displayName: string): Promise<PublicUser> {
    const normalised = normaliseEmail(email);
    if (!isPlausibleEmail(normalised)) {
      throw new AccountError('That does not look like an email address.');
    }
    const name = displayName.trim() || normalised.split('@')[0]!;
    if (name.length > 64) throw new AccountError('Display name must be under 64 characters.');

    // hashPassword enforces strength and throws WeakPasswordError, which the route surfaces as a
    // 400 rather than a 500.
    const hash = await hashPassword(password);

    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(normalised);
    if (existing) throw new EmailInUseError('An account already exists for that address.');

    const user: PublicUser = {
      id: randomUUID(),
      email: normalised,
      displayName: name,
      createdAt: new Date().toISOString(),
    };

    try {
      this.db
        .prepare('INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, user.email, user.displayName, serializeHash(hash), user.createdAt);
    } catch (error) {
      // The UNIQUE constraint is the real guard: two simultaneous registrations both pass the
      // check above, and only one can win the insert.
      if (String(error).includes('UNIQUE')) {
        throw new EmailInUseError('An account already exists for that address.');
      }
      throw error;
    }

    return user;
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
    const row = this.db
      .prepare('SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = ?')
      .get(normalised) as
      | { id: string; email: string; display_name: string; password_hash: string; created_at: string }
      | undefined;

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

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  }

  findUser(id: string): PublicUser | null {
    const row = this.db
      .prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?')
      .get(id) as { id: string; email: string; display_name: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
  }

  // --- Sessions ----------------------------------------------------------------------------------

  /** Start a session and return the token. The token itself is never stored, only its hash. */
  createSession(userId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, new Date().toISOString(), expiresAt.toISOString());

    return { token, expiresAt };
  }

  /**
   * Resolve a session token to its user, renewing it if it is getting old.
   *
   * Returns null for anything expired, unknown or malformed -- the caller cannot tell which, and
   * does not need to.
   */
  resolveSession(token: string | undefined): PublicUser | null {
    if (!token) return null;

    const row = this.db
      .prepare('SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?')
      .get(hashToken(token)) as
      | { token_hash: string; user_id: string; expires_at: string }
      | undefined;
    if (!row) return null;

    const expiresAt = new Date(row.expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }

    // Rolling expiry: extend an actively used session, but not on every single request.
    if (expiresAt - Date.now() < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
      this.db
        .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
        .run(new Date(Date.now() + SESSION_TTL_MS).toISOString(), row.token_hash);
    }

    return this.findUser(row.user_id);
  }

  destroySession(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /** Sign out everywhere. What a user wants after losing a laptop. */
  destroyAllSessions(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /** Housekeeping, so expired rows do not accumulate forever. */
  pruneSessions(): number {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  // --- Projects ----------------------------------------------------------------------------------

  listProjects(userId: string): ProjectSummary[] {
    return this.db
      .prepare('SELECT id, name, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId)
      .map((row) => {
        const r = row as { id: string; name: string; created_at: string; updated_at: string };
        return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
      });
  }

  /**
   * Read one project.
   *
   * Scoped by user id in the query itself rather than fetched and then checked. A missing row and
   * someone else's row are the same outcome here, which is what stops an id guess from confirming
   * that a project exists.
   */
  getProject(userId: string, id: string): StoredProject | null {
    const row = this.db
      .prepare('SELECT id, name, document, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?')
      .get(id, userId) as
      | { id: string; name: string; document: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      document: row.document,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createProject(userId: string, name: string, document: string): StoredProject {
    const now = new Date().toISOString();
    const project: StoredProject = {
      id: randomUUID(),
      name: name.trim() || 'Untitled',
      document,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare('INSERT INTO projects (id, user_id, name, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(project.id, userId, project.name, project.document, now, now);

    return project;
  }

  updateProject(userId: string, id: string, name: string, document: string): StoredProject {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE projects SET name = ?, document = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(name.trim() || 'Untitled', document, now, id, userId);

    if (Number(result.changes) === 0) throw new NotFoundError('No such project.');
    return this.getProject(userId, id)!;
  }

  deleteProject(userId: string, id: string): void {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, userId);
    if (Number(result.changes) === 0) throw new NotFoundError('No such project.');
  }

  /** Number of projects a user has, for the quota check. */
  countProjects(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?')
      .get(userId) as { n: number };
    return Number(row.n);
  }
}

/** Constant-time string comparison, for anything secret that is not already hashed. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export { WeakPasswordError };
