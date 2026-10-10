import { createDatabase, dateTime } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { provisionTenants } from './provisioning.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;
const when = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));
const t = (name: string) => sql.id('t_acme', name);
const sqlNumber = async (work: Promise<unknown>): Promise<number | undefined> =>
  work.then(
    () => undefined,
    (error: { number?: number }) => error.number,
  );

beforeAll(async () => {
  testDb = await createTestDatabase('recmig');
  db = createDatabase<unknown>(testDb.config);
  await provisionTenants(db, [TenantId.parse('acme')]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const insertRun = (id: string, day: string, status: string, by: string) =>
  sql`insert into ${t('reconciliation_runs')}
    (id, run_day, status, triggered_by, gateway_totals, wallet_totals, item_count, started_at)
    values (${id}, ${day}, ${status}, ${by}, '{}', '{}', 0, ${when()})`.execute(db);

describe('004-reconciliation', () => {
  it('allows one non-failed SCHEDULED run per day but any number of MANUAL or FAILED ones', async () => {
    await insertRun('r1', '2026-10-09', 'COMPLETED', 'SCHEDULED');
    expect(await sqlNumber(insertRun('r2', '2026-10-09', 'RUNNING', 'SCHEDULED'))).toBe(2601);
    await insertRun('r3', '2026-10-09', 'COMPLETED', 'MANUAL');
    await insertRun('r4', '2026-10-09', 'COMPLETED', 'MANUAL');
    await insertRun('r5', '2026-10-08', 'FAILED', 'SCHEDULED');
    await insertRun('r6', '2026-10-08', 'FAILED', 'SCHEDULED');
    await insertRun('r7', '2026-10-08', 'RUNNING', 'SCHEDULED');
  });

  it('rejects unknown statuses and triggers', async () => {
    expect(await sqlNumber(insertRun('bad1', '2026-10-01', 'BOGUS', 'MANUAL'))).toBe(547);
    expect(await sqlNumber(insertRun('bad2', '2026-10-01', 'COMPLETED', 'BOGUS'))).toBe(547);
  });

  it('keeps items tied to a run and constrains kind, action and case status', async () => {
    const insertItem = (
      id: string,
      runId: string,
      kind: string,
      action: string,
      caseStatus: string,
    ) =>
      sql`insert into ${t('reconciliation_items')}
        (id, run_id, kind, detail, action, case_status, created_at)
        values (${id}, ${runId}, ${kind}, '{}', ${action}, ${caseStatus}, ${when()})`.execute(db);
    await insertItem('i1', 'r1', 'MISSING_AT_WALLET', 'NONE', 'OPEN');
    expect(await sqlNumber(insertItem('i1', 'r1', 'MISSING_AT_WALLET', 'NONE', 'OPEN'))).toBe(2627);
    expect(await sqlNumber(insertItem('i2', 'nope', 'MISSING_AT_WALLET', 'NONE', 'OPEN'))).toBe(
      547,
    );
    expect(await sqlNumber(insertItem('i3', 'r1', 'BOGUS', 'NONE', 'OPEN'))).toBe(547);
    expect(await sqlNumber(insertItem('i4', 'r1', 'MISSING_AT_WALLET', 'BOGUS', 'OPEN'))).toBe(547);
    expect(await sqlNumber(insertItem('i5', 'r1', 'MISSING_AT_WALLET', 'NONE', 'BOGUS'))).toBe(547);
  });
});
