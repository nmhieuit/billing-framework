import {
  createDatabase,
  dateTime,
  isUniqueViolation,
  migrate,
  toSafeInteger,
} from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './sql-server.js';

interface Schema {
  samples: { id: string; amount: string; due_at: Date };
}

let testDb: TestDatabase;
let db: Kysely<Schema>;

beforeAll(async () => {
  testDb = await createTestDatabase('database');
  db = createDatabase<Schema>(testDb.config);
  await sql`create table samples (id nvarchar(40) primary key, amount bigint not null, due_at datetime2(3) not null)`.execute(
    db,
  );
});

afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('SQL Server access helpers', () => {
  it('keeps every millisecond when dates go through dateTime()', async () => {
    const instants = [
      '2026-10-09T10:00:00.001Z',
      '2026-10-09T10:00:00.004Z',
      '2026-10-09T10:00:00.999Z',
    ];
    for (const [index, iso] of instants.entries()) {
      await db
        .insertInto('samples')
        .values({ id: `d${index}`, amount: '1', due_at: dateTime(new Date(iso)) })
        .execute();
    }
    const rows = await db
      .selectFrom('samples')
      .select('due_at')
      .where('id', 'like', 'd%')
      .orderBy('id')
      .execute();
    expect(rows.map((r) => r.due_at.toISOString())).toEqual(instants);
  });

  it('returns bigint as a string that toSafeInteger converts', async () => {
    await sql`insert into samples values ('big', 9007199254740991, ${dateTime(new Date())})`.execute(
      db,
    );
    const row = await db
      .selectFrom('samples')
      .select('amount')
      .where('id', '=', 'big')
      .executeTakeFirstOrThrow();
    expect(typeof row.amount).toBe('string');
    expect(toSafeInteger(row.amount)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('exposes primary-key violations through isUniqueViolation', async () => {
    await db
      .insertInto('samples')
      .values({ id: 'conflict', amount: '1', due_at: dateTime(new Date()) })
      .execute();
    const second = db
      .insertInto('samples')
      .values({ id: 'conflict', amount: '1', due_at: dateTime(new Date()) })
      .execute();
    await expect(second).rejects.toSatisfy(isUniqueViolation);
  });

  it('applies migrations once and is a no-op the second time', async () => {
    const migrations = {
      '001_create_marker': {
        up: async (database: Kysely<unknown>) => {
          await sql`create table marker (id int primary key)`.execute(database);
        },
      },
    };
    expect(await migrate(db, migrations)).toEqual(['001_create_marker']);
    expect(await migrate(db, migrations)).toEqual([]);
  });
});
