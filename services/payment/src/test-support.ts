import { createDatabase, migrate } from '@billing/database';
import { FakeClock, createTestDatabase } from '@billing/testing';
import type { Kysely } from 'kysely';
import { paymentMigrations } from '../../../db/payment/migrations.js';
import type { IdGenerator } from './application/ports.js';
import type { PaymentDatabase } from './infrastructure/kysely/schema.js';
import { KyselyUnitOfWork } from './infrastructure/kysely/unit-of-work.js';

/** Mã định danh tất định để test so sánh được: ch_000001, evt_000001, ... */
export class SequentialIds implements IdGenerator {
  #charges = 0;
  #events = 0;

  chargeId(): string {
    return `ch_${String(++this.#charges).padStart(6, '0')}`;
  }

  eventId(): string {
    return `evt_${String(++this.#events).padStart(6, '0')}`;
  }
}

export interface Harness {
  db: Kysely<PaymentDatabase>;
  clock: FakeClock;
  ids: SequentialIds;
  uow: KyselyUnitOfWork;
  close(): Promise<void>;
}

/** Dựng một database riêng đã migrate, kèm clock giả và id tất định. Chỉ dùng trong integration test. */
export async function createHarness(start = '2026-10-09T10:00:00.000Z'): Promise<Harness> {
  const testDb = await createTestDatabase('payment');
  const db = createDatabase<PaymentDatabase>(testDb.config);
  await migrate(db, paymentMigrations);
  return {
    db,
    clock: new FakeClock(start),
    ids: new SequentialIds(),
    uow: new KyselyUnitOfWork(db),
    async close() {
      await db.destroy();
      await testDb.drop();
    },
  };
}

/** Xóa sạch dữ liệu theo đúng thứ tự khóa ngoại. */
export async function resetTables(db: Kysely<PaymentDatabase>): Promise<void> {
  await db.deleteFrom('webhook_attempts').execute();
  await db.deleteFrom('webhook_events').execute();
  await db.deleteFrom('idempotency_keys').execute();
  await db.deleteFrom('charges').execute();
}
