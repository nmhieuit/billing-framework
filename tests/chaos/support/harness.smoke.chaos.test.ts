import { createTestDatabase } from '@billing/testing';
import { sql } from 'kysely';
import { createDatabase } from '@billing/database';
import { describe, expect, it } from 'vitest';

// Smoke: xác nhận cấu hình chaos chạy được và có SQL Server từ globalSetup.
describe('chaos harness smoke', () => {
  it('runs under the chaos config and reaches the shared SQL Server', async () => {
    const testDb = await createTestDatabase('chaos_smoke');
    const db = createDatabase<unknown>(testDb.config);
    try {
      const result = await sql<{ one: number }>`select 1 as one`.execute(db);
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await db.destroy();
      await testDb.drop();
    }
  });
});
