import { MissingTenantError, UnknownTenantError } from '../application/errors.js';
import type { TenantRegistry } from '../application/ports.js';
import { InvalidTenantError } from '../domain/errors.js';
import { TenantId } from '../domain/tenant-id.js';

export class ConfigTenantRegistry implements TenantRegistry {
  readonly #byValue: Map<string, TenantId>;

  constructor(private readonly tenants: readonly TenantId[]) {
    this.#byValue = new Map(tenants.map((tenant) => [tenant.value, tenant]));
  }

  resolve(raw: string | undefined): TenantId {
    if (raw === undefined || raw.trim() === '') {
      throw new MissingTenantError('tenant is required');
    }
    let parsed: TenantId;
    try {
      parsed = TenantId.parse(raw);
    } catch (error) {
      if (error instanceof InvalidTenantError) throw new UnknownTenantError('unknown tenant');
      throw error;
    }
    const known = this.#byValue.get(parsed.value);
    if (!known) throw new UnknownTenantError('unknown tenant');
    return known;
  }

  all(): readonly TenantId[] {
    return this.tenants;
  }
}
