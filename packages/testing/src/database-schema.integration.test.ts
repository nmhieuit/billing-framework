import { createDatabase, migrate, pendingMigrations, type Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './sql-server.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;

const migrations: Record<string, Migration> = {
  '001-a': {
    up: async (database: Kysely<unknown>) => {
      await sql`create table [s_one].[a] (id int primary key)`.execute(database);
    },
  },
  '002-b': {
    up: async (database: Kysely<unknown>) => {
      await sql`create table [s_one].[b] (id int primary key)`.execute(database);
    },
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase('dbschema');
  db = createDatabase<unknown>(testDb.config);
  await sql`create schema [s_one]`.execute(db);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('migrate / pendingMigrations with migrationTableSchema', () => {
  it('reports everything pending before the schema has a migration table, without creating one', async () => {
    expect(await pendingMigrations(db, migrations, { migrationTableSchema: 's_one' })).toEqual([
      '001-a',
      '002-b',
    ]);
    const tables = await sql<{ name: string }>`select name from sys.tables`.execute(db);
    expect(tables.rows.map((r) => r.name)).not.toContain('kysely_migration');
  });

  it('also treats a schema that does not exist as fully pending', async () => {
    expect(await pendingMigrations(db, migrations, { migrationTableSchema: 's_missing' })).toEqual([
      '001-a',
      '002-b',
    ]);
  });

  it('keeps the migration bookkeeping in the given schema and is idempotent', async () => {
    expect(await migrate(db, migrations, { migrationTableSchema: 's_one' })).toEqual([
      '001-a',
      '002-b',
    ]);
    expect(await migrate(db, migrations, { migrationTableSchema: 's_one' })).toEqual([]);
    const tables = await sql<{ schema_name: string; name: string }>`
      select s.name as schema_name, t.name from sys.tables t join sys.schemas s on s.schema_id = t.schema_id
      where t.name in ('kysely_migration', 'kysely_migration_lock')`.execute(db);
    expect(tables.rows.map((r) => `${r.schema_name}.${r.name}`).sort()).toEqual([
      's_one.kysely_migration',
      's_one.kysely_migration_lock',
    ]);
    expect(await pendingMigrations(db, migrations, { migrationTableSchema: 's_one' })).toEqual([]);
  });

  it('lists only the migrations that were not applied yet', async () => {
    const more: Record<string, Migration> = {
      ...migrations,
      '003-c': { up: async () => undefined },
    };
    expect(await pendingMigrations(db, more, { migrationTableSchema: 's_one' })).toEqual(['003-c']);
  });
});
