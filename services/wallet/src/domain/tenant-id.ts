import { InvalidTenantError } from './errors.js';

const TENANT = /^[a-z][a-z0-9-]{0,39}$/;

/** Định danh tenant đã được kiểm tra. Chỉ tạo được qua `parse`, nên mọi nơi nhận `TenantId` đều an toàn khi dựng tên schema. */
export class TenantId {
  private constructor(readonly value: string) {}

  static parse(raw: string): TenantId {
    if (!TENANT.test(raw)) {
      throw new InvalidTenantError(`tenant id must match ${TENANT.source}`);
    }
    return new TenantId(raw);
  }

  equals(other: TenantId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
