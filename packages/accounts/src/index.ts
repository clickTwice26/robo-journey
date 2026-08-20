/**
 * @robo-journey/accounts
 *
 * Accounts, sessions and project storage. Server-side only: importing this into the browser would
 * put password hashing and the database in the bundle.
 */
export {
  AccountError,
  AccountStore,
  EmailInUseError,
  InvalidCredentialsError,
  NotFoundError,
  SESSION_TTL_MS,
  isPlausibleEmail,
  normaliseEmail,
  safeEqual,
} from './store.js';
export type { ProjectSummary, PublicUser, StoredProject } from './store.js';

export {
  ACCESS_CAPACITY,
  ACCESS_COOLDOWN_MS,
  ACCESS_GRACE_MS,
  ACCESS_IDLE_MS,
  ACCESS_SESSION_MS,
  AccessController,
  CooldownError,
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
