import { migrate, pendingMigrations } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import type { TenantId } from '../../domain/tenant-id.js';
import { walletMigrations } from './migrations/index.js';
import { assertSchemaName, schemaName } from './schema-name.js';

/**
 * Cấp phát từng tenant: tạo schema nếu chưa có rồi chạy migration trong schema đó (bảng theo dõi nằm
 * trong schema). Idempotent. Phải chạy bằng tài khoản thuộc `db_owner` (xem `migrate`).
 */
export async function provisionTenants(
  owner: Kysely<unknown>,
  tenants: readonly TenantId[],
): Promise<Record<string, string[]>> {
  const applied: Record<string, string[]> = {};
  for (const tenant of tenants) {
    const schema = assertSchemaName(schemaName(tenant));
    await sql
      .raw(
        `if not exists (select 1 from sys.schemas where name = '${schema}') exec('create schema [${schema}]')`,
      )
      .execute(owner);
    applied[tenant.value] = await migrate(owner, walletMigrations(schema), {
      migrationTableSchema: schema,
    });
  }
  return applied;
}

/** Khởi động an toàn: mọi tenant đã được cấp phát và migrate xong, nếu không thì ném lỗi nêu rõ tenant nào còn thiếu gì. */
export async function assertMigrated(
  db: Kysely<unknown>,
  tenants: readonly TenantId[],
): Promise<void> {
  const problems: string[] = [];
  for (const tenant of tenants) {
    const schema = assertSchemaName(schemaName(tenant));
    const pending = await pendingMigrations(db, walletMigrations(schema), {
      migrationTableSchema: schema,
    });
    if (pending.length > 0) {
      problems.push(`tenant "${tenant.value}" has pending migrations: ${pending.join(', ')}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`database is not migrated (run db:migrate:wallet): ${problems.join('; ')}`);
  }
}
