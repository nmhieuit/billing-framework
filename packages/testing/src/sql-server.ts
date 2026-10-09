import { randomUUID } from 'node:crypto';
import { createDatabase, type DatabaseConfig } from '@billing/database';
import { sql } from 'kysely';
import { inject } from 'vitest';
import './provided-context.js';

export interface TestDatabase {
  config: DatabaseConfig;
  drop(): Promise<void>;
}

/** Tạo một database mới, tên ngẫu nhiên, trên SQL Server của testcontainers. */
export async function createTestDatabase(prefix = 'test'): Promise<TestDatabase> {
  const server = inject('sqlServer');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const base = {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
  };

  const withAdmin = async (statement: string): Promise<void> => {
    const admin = createDatabase<unknown>({ ...base, database: 'master', poolMax: 1 });
    try {
      await sql.raw(statement).execute(admin);
    } finally {
      await admin.destroy();
    }
  };

  await withAdmin(`create database [${name}]`);

  return {
    config: { ...base, database: name, poolMax: 4 },
    drop: () =>
      withAdmin(
        `alter database [${name}] set single_user with rollback immediate; drop database [${name}]`,
      ),
  };
}
