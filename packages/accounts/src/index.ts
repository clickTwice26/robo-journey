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
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from './passwords.js';
export type { PasswordHash } from './passwords.js';
