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

  it('rejects a mail server pointed at localhost links', () => {
    // Every link in outgoing mail is built from RJ_PUBLIC_URL, so this would send recipients to
    // their own machine.
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' }),
    ).toThrow(/localhost/);
  });

  it('allows localhost links while mail only goes to the log', () => {
    // The stack on a laptop sets NODE_ENV=production too, and a localhost link is exactly right
    // when nothing is being posted anywhere. Keying this off the environment crash-looped it.
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).not.toThrow();
  });

  it('names the variable when one is missing', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6379' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
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
