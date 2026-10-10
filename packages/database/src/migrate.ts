import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import { isMissingObject } from './errors.js';

export type { Migration };

export interface MigrateOptions {
  /** Đặt bảng theo dõi migration của Kysely trong schema này (schema phải tồn tại trước). */
  migrationTableSchema?: string;
}

const MIGRATION_TABLE = 'kysely_migration';

/**
 * Áp dụng mọi migration chưa chạy theo thứ tự tên; ném lỗi nếu có migration thất bại.
 * Lưu ý: `Migrator` của Kysely dùng `sp_getapplock` nên phải chạy bằng tài khoản thuộc `db_owner`.
 */
export async function migrate<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
  options: MigrateOptions = {},
): Promise<string[]> {
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: { getMigrations: async () => migrations },
    ...(options.migrationTableSchema === undefined
      ? {}
      : { migrationTableSchema: options.migrationTableSchema }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/**
 * Tên các migration chưa chạy, đọc thẳng bảng theo dõi (không tạo bảng, không cần quyền DDL).
 * Bảng hoặc schema chưa tồn tại nghĩa là chưa migration nào chạy.
 */
export async function pendingMigrations<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
  options: MigrateOptions = {},
): Promise<string[]> {
  const table =
    options.migrationTableSchema === undefined
      ? sql.id(MIGRATION_TABLE)
      : sql.id(options.migrationTableSchema, MIGRATION_TABLE);
  let executed: Set<string>;
  try {
    const result = await sql<{ name: string }>`select name from ${table}`.execute(db);
    executed = new Set(result.rows.map((row) => row.name));
  } catch (error) {
    if (!isMissingObject(error)) throw error;
    executed = new Set();
  }
  return Object.keys(migrations)
    .filter((name) => !executed.has(name))
    .sort();
}
