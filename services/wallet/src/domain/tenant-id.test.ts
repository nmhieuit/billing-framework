import { describe, expect, it } from 'vitest';
import { InvalidTenantError } from './errors.js';
import { TenantId } from './tenant-id.js';

describe('TenantId.parse', () => {
  it.each(['acme', 'a', 'tenant-1', 'a'.repeat(40), 'x9-y9'])('accepts %s', (raw) => {
    expect(TenantId.parse(raw).value).toBe(raw);
    expect(TenantId.parse(raw).toString()).toBe(raw);
  });

  it.each([
    '',
    ' acme',
    'Acme',
    '1acme',
    '-acme',
    'ac_me',
    'ac me',
    'ac/me',
    'ac]me',
    'a'.repeat(41),
    'acme\n',
  ])('rejects %j', (raw) => {
    expect(() => TenantId.parse(raw)).toThrow(InvalidTenantError);
  });

  it('compares by value', () => {
    expect(TenantId.parse('acme').equals(TenantId.parse('acme'))).toBe(true);
    expect(TenantId.parse('acme').equals(TenantId.parse('beta'))).toBe(false);
  });
});
