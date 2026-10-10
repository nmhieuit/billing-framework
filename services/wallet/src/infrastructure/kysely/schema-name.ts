import type { TenantId } from '../../domain/tenant-id.js';

const SCHEMA = /^t_[a-z][a-z0-9-]{0,39}$/;

/** Tên schema của tenant. `TenantId` đã được kiểm tra nên tên này luôn an toàn khi quote. */
export function schemaName(tenant: TenantId): string {
  return `t_${tenant.value}`;
}

/** Chặn tên schema lạ trước khi dùng trong DDL hay SQL thô. */
export function assertSchemaName(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error(`invalid tenant schema name: ${schema}`);
  return schema;
}
