import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../application/errors.js';
import { TenantId } from '../domain/tenant-id.js';
import { ConfigTenantRegistry } from './tenant-registry.js';

const registry = new ConfigTenantRegistry([TenantId.parse('acme'), TenantId.parse('beta')]);

describe('ConfigTenantRegistry', () => {
  it('resolves configured tenants', () => {
    expect(registry.resolve('acme').value).toBe('acme');
    expect(registry.resolve('beta').value).toBe('beta');
  });

  it('lists every configured tenant', () => {
    expect(registry.all().map((t) => t.value)).toEqual(['acme', 'beta']);
  });

  it.each([undefined, '', '   '])('treats %j as a missing tenant', (raw) => {
    expect(() => registry.resolve(raw)).toThrow(MissingTenantError);
  });

  it.each(['gamma', 'ACME', 'acme ', 'a/b', '1x'])('treats %j as an unknown tenant', (raw) => {
    expect(() => registry.resolve(raw)).toThrow(UnknownTenantError);
  });
});
