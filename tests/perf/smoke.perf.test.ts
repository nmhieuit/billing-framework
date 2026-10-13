import { createDatabase } from '@billing/database';
import { createTestDatabase } from '@billing/testing';
import { sql } from 'kysely';
import { describe, expect, inject, it } from 'vitest';

// Smoke: xác nhận cấu hình perf chạy được và có SQL Server từ globalSetup.
describe('perf harness smoke', () => {
  it('runs under the perf config and reaches the shared SQL Server', async () => {
    expect(inject('sqlServer').host).toBeTruthy();
    const testDb = await createTestDatabase('perf_smoke');
    try {
      const db = createDatabase<unknown>(testDb.config);
      try {
        const result = await sql<{ one: number }>`select 1 as one`.execute(db);
        expect(result.rows[0]?.one).toBe(1);
      } finally {
        await db.destroy();
      }
    } finally {
      await testDb.drop();
    }
  });
});
