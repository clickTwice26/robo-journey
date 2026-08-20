/**
 * Configuration.
 *
 * Pure, so it needs no database and runs everywhere. Worth testing because the failures it exists
 * to prevent are all of the same kind: a service that starts, looks healthy, and is quietly wrong
 * until somebody tries the one thing that was misconfigured.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
} as NodeJS.ProcessEnv;

/** Anything configuring a real mail server also needs somewhere for its links to point. */
const withMail = { ...base, RJ_PUBLIC_URL: 'https://studio.example.com' } as NodeJS.ProcessEnv;

describe('SMTP settings', () => {
  it('takes the unprefixed names a mail host hands out', () => {
    const config = loadConfig({ ...withMail, SMTP_HOST: 'smtp.example.com', SMTP_PASSWORD: 'secret' });
    expect(config.SMTP_HOST).toBe('smtp.example.com');
    expect(config.SMTP_PASSWORD).toBe('secret');
  });

  it('still accepts the older prefixed spellings', () => {
    const config = loadConfig({ ...withMail, RJ_SMTP_HOST: 'old.example.com', RJ_SMTP_PASS: 'secret' });
    expect(config.SMTP_HOST).toBe('old.example.com');
    expect(config.SMTP_PASSWORD).toBe('secret');
  });

  it('prefers the canonical name when both are set', () => {
    const config = loadConfig({ ...withMail, SMTP_HOST: 'new.example.com', RJ_SMTP_HOST: 'old.example.com' });
    expect(config.SMTP_HOST).toBe('new.example.com');
  });

  it('infers implicit TLS on 465', () => {
    // Nobody sets a port and then a separate flag saying what that port implies, and getting it
    // wrong fails in a way that reads like bad credentials rather than a protocol mismatch.
    expect(loadConfig({ ...withMail, SMTP_HOST: 'x', SMTP_PORT: '465' }).SMTP_SECURE).toBe(true);
  });

  it('leaves 587 on STARTTLS', () => {
    expect(loadConfig({ ...withMail, SMTP_HOST: 'x', SMTP_PORT: '587' }).SMTP_SECURE).toBe(false);
  });

  it('lets an explicit setting win over the port', () => {
    expect(loadConfig({ ...withMail, SMTP_HOST: 'x', SMTP_PORT: '465', SMTP_SECURE: 'false' }).SMTP_SECURE).toBe(
      false,
    );
  });
});

describe('refusing to start', () => {
  it('rejects a production deploy that demands verification but cannot send mail', () => {
    // Otherwise it looks like a working deploy right up until the first signup, and then nobody
    // who registers can ever take a seat.
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', RJ_PUBLIC_URL: 'https://example.com' }),
    ).toThrow(ConfigError);
  });

  it('accepts one that has a mail server', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        RJ_PUBLIC_URL: 'https://example.com',
        SMTP_HOST: 'smtp.example.com',
      }),
    ).not.toThrow();
  });

  it('accepts one that has switched verification off', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        RJ_PUBLIC_URL: 'https://example.com',
        RJ_REQUIRE_VERIFIED_EMAIL: 'false',
      }),
    ).not.toThrow();
  });

  it('treats an empty variable as an absent one', () => {
    // Compose has no way to say "unset": `SMTP_SECURE: ${SMTP_SECURE:-}` passes an empty string,
    // which failed validation and crash-looped the service.
    expect(() => loadConfig({ ...base, SMTP_SECURE: '', SMTP_HOST: '' })).not.toThrow();
    expect(loadConfig({ ...base, SMTP_HOST: '' }).SMTP_HOST).toBeUndefined();
  });

  it('names the variable when one is missing', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });
});

describe('warnings', () => {
  it('says so when mail links point at localhost, without refusing to start', async () => {
    // Testing real mail against a local stack is a legitimate thing to be doing. A fatal check
    // here is not a safety net, it is a crash loop -- which is exactly what it caused.
    const { configWarnings } = await import('../src/config.js');
    const config = loadConfig({ ...base, SMTP_HOST: 'smtp.example.com' });
    expect(configWarnings(config).join(' ')).toMatch(/RJ_PUBLIC_URL/);
  });

  it('says nothing when the links are public', async () => {
    const { configWarnings } = await import('../src/config.js');
    const config = loadConfig({ ...withMail, SMTP_HOST: 'smtp.example.com', RJ_TRUST_PROXY: 'true' });
    expect(configWarnings(config)).toEqual([]);
  });

  it('flags https behind an untrusted proxy', async () => {
    // The session cookie's Secure flag and every per-address rate limit depend on it.
    const { configWarnings } = await import('../src/config.js');
    const config = loadConfig({ ...withMail, SMTP_HOST: 'smtp.example.com' });
    expect(configWarnings(config).join(' ')).toMatch(/RJ_TRUST_PROXY/);
  });
});

describe('what it reports about itself', () => {
  it('never includes a secret', async () => {
    const { describeConfig } = await import('../src/config.js');
    const config = loadConfig({
      ...withMail,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PASSWORD: 'hunter2-and-then-some',
      GEMINI_API_KEY: 'AIza-not-a-real-key',
    });
    const text = JSON.stringify(describeConfig(config));

    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('AIza');
    expect(text).not.toContain('postgres://');
    // But it does say whether they are set, which is the question being asked.
    expect(JSON.parse(text).datasheetExtraction).toBe(true);
    expect(JSON.parse(text).mail).toBe('smtp');
  });
});
