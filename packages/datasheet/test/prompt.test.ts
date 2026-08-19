/**
 * Prompt construction and response parsing.
 *
 * Offline: these run without an API key and without spending anything. The live extraction tests
 * live in `extract.live.ts` and run under `npm run test:live`.
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_VERSION,
  RULES,
  SCHEMA_GUIDE,
  buildPrompt,
  buildRepairPrompt,
  extractJson,
} from '../src/index.js';

describe('buildPrompt', () => {
  it('includes the schema and the rules', () => {
    const prompt = buildPrompt({});
    expect(prompt).toContain(SCHEMA_GUIDE);
    expect(prompt).toContain(RULES);
  });

  it('spells out the unit conversions that cause the worst errors', () => {
    // A milliamp figure taken as amps passes every structural check and makes a simulated part
    // brown out a board the real one would not, so the prompt must be explicit.
    expect(RULES).toContain('20 mA');
    expect(RULES).toContain('0.02');
    expect(RULES).toContain('10 us');
    expect(RULES).toContain('0.00001');
  });

  it('tells the model that an unresolved list is success, not failure', () => {
    // Without this a model invents plausible numbers, which is strictly worse than a gap because
    // a gap can be checked.
    expect(RULES).toMatch(/unresolved.*is a successful extraction/is);
  });

  it('carries a user hint through', () => {
    expect(buildPrompt({ hint: 'MPU-6050' })).toContain('MPU-6050');
  });

  it('embeds datasheet text when there is no PDF', () => {
    expect(buildPrompt({ text: 'Working Voltage: 5 V' })).toContain('Working Voltage: 5 V');
  });

  it('omits the text block entirely when none is given', () => {
    expect(buildPrompt({})).not.toContain('DATASHEET TEXT');
  });
});

describe('buildRepairPrompt', () => {
  it('lists the specific problems rather than asking for another attempt', () => {
    // Re-running from scratch reproduces the same mistake; naming the failure fixes it.
    const prompt = buildRepairPrompt('{"id":"x"}', ['pins[0].model.vil: VIL must be below VIH']);
    expect(prompt).toContain('VIL must be below VIH');
    expect(prompt).toContain('{"id":"x"}');
  });

  it('reminds the model to check units first', () => {
    expect(buildRepairPrompt('{}', ['bad'])).toMatch(/milliamps, microseconds or kilohms/);
  });
});

describe('extractJson', () => {
  it('passes plain JSON through', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a markdown fence', () => {
    // Models add fences despite being told not to; failing over that would be needless.
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('discards prose either side of the object', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('keeps nested braces intact', () => {
    const json = '{"a":{"b":[1,2]},"c":3}';
    expect(extractJson(`prefix ${json} suffix`)).toBe(json);
  });

  it('returns the input unchanged when there is no object to find', () => {
    expect(extractJson('not json at all')).toBe('not json at all');
  });
});

describe('prompt versioning', () => {
  it('has a version, so a manifest records which prompt produced it', () => {
    // Extraction quality changes with the prompt; without the version a stored manifest cannot be
    // attributed to the prompt that made it.
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});
