import type { Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';

export type { Migration };

/** Áp dụng mọi migration chưa chạy theo thứ tự tên; ném lỗi nếu có migration thất bại. */
export async function migrate<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
): Promise<string[]> {
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: { getMigrations: async () => migrations },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
