import { createDatabase, dateTime, migrate } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentMigrations } from './migrations.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;

beforeAll(async () => {
  testDb = await createTestDatabase('migrations');
  db = createDatabase<unknown>(testDb.config);
});

afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('payment migrations', () => {
  it('apply once and are a no-op the second time', async () => {
    expect(await migrate(db, paymentMigrations)).toEqual(['001-init']);
    expect(await migrate(db, paymentMigrations)).toEqual([]);
  });

  it('create the four tables', async () => {
    const result = await sql<{ name: string }>`select name from sys.tables`.execute(db);
    expect(result.rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['charges', 'idempotency_keys', 'webhook_events', 'webhook_attempts']),
    );
  });

  it('create the indexes the worker relies on for READPAST and the settlement paging', async () => {
    const result = await sql<{ name: string }>`
      select name from sys.indexes
      where name in ('ix_charges_due', 'ix_charges_completed', 'ix_webhook_due')`.execute(db);
    expect(result.rows.map((r) => r.name).sort()).toEqual([
      'ix_charges_completed',
      'ix_charges_due',
      'ix_webhook_due',
    ]);
  });

  it.each([
    ['a zero amount', 0, 'PENDING'],
    ['a negative amount', -5, 'PENDING'],
    ['an unknown status', 1, 'WEIRD'],
  ])('reject %s with a CHECK constraint violation', async (_name, amount, status) => {
    const now = dateTime(new Date());
    const insert = sql`
      insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at)
      values (${`c-${amount}-${status}`}, ${'r'}, ${amount}, ${'VND'}, ${status}, ${'{}'}, ${now}, ${now})`.execute(
      db,
    );
    await expect(insert).rejects.toMatchObject({ number: 547 });
  });
});
