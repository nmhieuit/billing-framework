import { createDatabase } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { provisionTenants } from './provisioning.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;

beforeAll(async () => {
  testDb = await createTestDatabase('retmig');
  db = createDatabase<unknown>(testDb.config);
  await provisionTenants(db, [TenantId.parse('acme')]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const indexOf = async (table: string, name: string) => {
  const rows = await sql<{ is_unique: boolean; has_filter: boolean }>`
    select i.is_unique, i.has_filter from sys.indexes i
    join sys.tables tb on tb.object_id = i.object_id
    join sys.schemas s on s.schema_id = tb.schema_id
    where s.name = 't_acme' and tb.name = ${table} and i.name = ${name}`.execute(db);
  return rows.rows[0];
};

describe('006-retention-indexes', () => {
  it('adds a filtered index on sent outbox rows', async () => {
    const ix = await indexOf('outbox', 'ix_outbox_sent');
    expect(ix).toBeDefined();
    expect(ix?.has_filter).toBeTruthy();
  });

  it('adds plain non-unique indexes for processed messages and idempotency keys', async () => {
    const processed = await indexOf('processed_messages', 'ix_processed_messages_at');
    const keys = await indexOf('idempotency_keys', 'ix_idempotency_keys_created');
    expect(processed).toBeDefined();
    expect(keys).toBeDefined();
    expect(processed?.is_unique).toBeFalsy();
    expect(keys?.is_unique).toBeFalsy();
  });

  it('is idempotent when provisioning again', async () => {
    expect(await provisionTenants(db, [TenantId.parse('acme')])).toEqual({ acme: [] });
  });
});
