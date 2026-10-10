import { describe, expect, it } from 'vitest';
import { InvalidChargeError } from './errors.js';
import { EMPTY_METADATA, parseMetadata, parseStoredMetadata } from './metadata.js';

describe('parseMetadata', () => {
  it('treats undefined as empty', () => {
    expect(parseMetadata(undefined)).toBe(EMPTY_METADATA);
  });

  it('accepts string values and returns the keys sorted', () => {
    const parsed = parseMetadata({ tenantId: 'acme', a1: 'x' });
    expect(Object.keys(parsed)).toEqual(['a1', 'tenantId']);
    expect(parsed).toEqual({ a1: 'x', tenantId: 'acme' });
  });

  it('accepts exactly 10 keys, a 40-character key and a 200-character value', () => {
    const tenKeys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v']));
    expect(() => parseMetadata(tenKeys)).not.toThrow();
    expect(() => parseMetadata({ [`a${'b'.repeat(39)}`]: 'v' })).not.toThrow();
    expect(() => parseMetadata({ k: 'x'.repeat(200) })).not.toThrow();
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', ['a']],
    ['11 keys', Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']))],
    ['a key starting with a digit', { '1a': 'v' }],
    ['a key with a dash', { 'a-b': 'v' }],
    ['a 41-character key', { [`a${'b'.repeat(40)}`]: 'v' }],
    ['a non-string value', { k: 1 }],
    ['a 201-character value', { k: 'x'.repeat(201) }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseMetadata(raw)).toThrow(InvalidChargeError);
  });
});

describe('parseStoredMetadata', () => {
  it('maps null to empty and parses stored JSON', () => {
    expect(parseStoredMetadata(null)).toEqual({});
    expect(parseStoredMetadata('{"tenantId":"acme"}')).toEqual({ tenantId: 'acme' });
  });
});
