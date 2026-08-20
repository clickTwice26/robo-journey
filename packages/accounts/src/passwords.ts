/**
 * Password hashing.
 *
 * scrypt from Node's own crypto, rather than a native argon2 binding. argon2id is the better
 * algorithm on paper, but it means a compiled dependency that has to build on every machine the
 * project is cloned onto; scrypt is memory-hard, well studied, and already here. The work factor
 * matters far more than the choice between the two.
 *
 * Nothing in this file logs, returns, or otherwise exposes a plaintext password.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Promise wrapper for scrypt.
 *
 * Hand-written rather than `promisify`, which resolves to the three-argument overload and drops
 * the options object -- silently hashing at Node's defaults instead of the cost parameters chosen
 * here, which is the difference between a 55 ms hash and a 0.5 ms one.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Cost parameters.
 *
 * N = 2^15 costs about 55 ms per hash on a modern laptop. Slow enough that guessing is expensive,
 * fast enough that a login does not feel broken. `maxmem` has to be raised explicitly: Node's
 * default ceiling is below what N this large needs, and the failure is a confusing runtime error
 * rather than a bad hash.
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAX_MEM = 128 * 1024 * 1024;

/** Shortest password accepted. Length beats character-class rules for real-world strength. */
export const MIN_PASSWORD_LENGTH = 10;
/**
 * Longest accepted.
 *
 * Not a strength limit -- a cap so an enormous submitted password cannot be used to make the
 * server do unbounded hashing work.
 */
export const MAX_PASSWORD_LENGTH = 512;

/** Stored form: the parameters travel with the hash, so they can be raised later without a reset. */
export interface PasswordHash {
  readonly algorithm: 'scrypt';
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly hash: string;
}

export class WeakPasswordError extends Error {}

/** Reject the passwords that are genuinely worth rejecting, and nothing else. */
export function checkPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be under ${MAX_PASSWORD_LENGTH} characters.`);
  }
  // A handful of passwords are so common that any rule set should refuse them by name.
  const trivial = new Set([
    'password123', 'qwertyuiop', '1234567890', 'passw0rd123',
    'letmein1234', 'iloveyou123', 'administrator',
  ]);
  if (trivial.has(password.toLowerCase())) {
    throw new WeakPasswordError('That password is among the most commonly used. Choose another.');
  }
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  checkPasswordStrength(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM,
  });

  return {
    algorithm: 'scrypt',
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    hash: derived.toString('base64'),
  };
}

/**
 * Verify a password against a stored hash.
 *
 * Compared in constant time. A plain `===` on the derived keys leaks how many leading bytes
 * matched, which over enough attempts is enough to reconstruct the hash.
 */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  if (stored.algorithm !== 'scrypt') return false;

  const salt = Buffer.from(stored.salt, 'base64');
  const expected = Buffer.from(stored.hash, 'base64');

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, {
      N: stored.n, r: stored.r, p: stored.p, maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Serialise for storage as a single column. */
export function serializeHash(hash: PasswordHash): string {
  return JSON.stringify(hash);
}

export function deserializeHash(text: string): PasswordHash {
  return JSON.parse(text) as PasswordHash;
}
