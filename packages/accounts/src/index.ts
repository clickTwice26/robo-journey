/**
 * @robo-journey/accounts
 *
 * Accounts, sessions and project storage. Server-side only: importing this into the browser would
 * put password hashing and the database in the bundle.
 */
export { createPool, waitForDatabase, withTransaction } from './db.js';
export type { DatabaseOptions } from './db.js';

export { MIGRATIONS, appliedMigrations, migrate } from './migrations.js';
export type { Migration } from './migrations.js';

export {
  AccountError,
  AccountStore,
  EmailInUseError,
  InvalidCredentialsError,
  NotFoundError,
  SESSION_TTL_MS,
  isPlausibleEmail,
  normaliseEmail,
  isUuid,
  safeEqual,
} from './store.js';
export type { ProjectSummary, PublicUser, StoredProject } from './store.js';

export {
  RESET_TOKEN_TTL_MS,
  TokenError,
  VERIFY_TOKEN_TTL_MS,
  consumeEmailToken,
  issueEmailToken,
  pruneEmailTokens,
} from './email-tokens.js';
export type { ConsumedToken, EmailTokenKind, IssuedToken, TokenFailure } from './email-tokens.js';

export { CreditStore, InsufficientCreditsError } from './credits.js';
export type {
  CreditBalance,
  CreditEntryKind,
  CreditFeature,
  Hold,
  LedgerEntry,
} from './credits.js';

export {
  ACCESS_CAPACITY,
  ACCESS_GRACE_MS,
  ACCESS_IDLE_MS,
  ACCESS_SESSION_MS,
  AccessController,
} from './access.js';
export type { AccessConfig, AccessState, AccessStatus } from './access.js';

export {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from './passwords.js';
export type { PasswordHash } from './passwords.js';

export { INVITE_REWARD, InviteError, Invites, normaliseCode } from './invites.js';
export type { InviteSummary } from './invites.js';
