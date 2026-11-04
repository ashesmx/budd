import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/bus/addressing.js';
import { BusError } from '../src/bus/errors.js';

describe('parseAddress', () => {
  it.each([
    ['grok-build/researcher', ['grok-build', 'researcher']],
    ['local/grok-build/researcher', ['local', 'grok-build', 'researcher']],
    ['  Grok-Build/Researcher ', ['grok-build', 'researcher']],
  ])('%j', (input, parts) => {
    expect(parseAddress(input)).toEqual(parts);
  });

  it('rejects "@" anywhere as reserved for federation', () => {
    for (const a of ['grok@host', 'local/grok-build/r@x', '@grok/researcher']) {
      expect(() => parseAddress(a)).toThrow(/reserved for future federation/);
    }
  });

  it('rejects a bare connection with a hint to add a handle', () => {
    expect(() => parseAddress('grok-build')).toThrow(/missing a handle.*grok-build\/researcher/);
  });

  it.each([
    '',
    '/',
    'a/b',
    'x/',
    '/x',
    'a/b/c/d',
    'grok build/r',
    'grok_build/researcher',
    'ws/c/' + 'h'.repeat(41),
  ])('rejects malformed %j', (input) => {
    try {
      parseAddress(input);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BusError);
      expect((err as BusError).code).toBe('invalid_address');
    }
  });
});
