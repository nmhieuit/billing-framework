import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_RETENTION_POLICIES,
  type PaymentRetentionPolicy,
} from '../../application/retention.js';
import { createHarness, resetTables, type Harness } from '../../test-support.js';
import { RETENTION_TARGET_TABLES } from './retention.repository.js';

let h: Harness;

const CUTOFF = new Date('2026-06-01T00:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');
const YOUNG = new Date('2026-07-01T00:00:00Z');
const FAR_FUTURE = new Date('2999-01-01T00:00:00Z');

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
// Các policy xóa theo ngưỡng thời gian trên toàn bảng, nên mỗi test bắt đầu từ bảng rỗng
// để kết quả đếm chính xác và test độc lập với nhau.
beforeEach(async () => {
  await resetTables(h.db);
});

const purge = (
  policy: PaymentRetentionPolicy,
  options: { cutoff?: Date; batch?: number; dryRun?: boolean } = {},
) =>
  h.uow.run(({ retention }) =>
    retention.purge(
      policy,
      options.cutoff ?? CUTOFF,
      options.batch ?? 1000,
      options.dryRun ?? false,
    ),
  );

/** Xóa từng lô đến khi hết dòng đủ điều kiện; trả tổng số đã xóa. */
const purgeAll = async (
  policy: PaymentRetentionPolicy,
  options: { cutoff?: Date } = {},
): Promise<number> => {
  let total = 0;
  for (;;) {
    const n = await purge(policy, { ...options, batch: 7 });
    if (n === 0) return total;
    total += n;
  }
};

const countOf = async (table: string): Promise<number> =>
  Number(
    (await sql<{ n: number }>`select count(*) as n from ${sql.id(table)}`.execute(h.db)).rows[0]?.n,
  );

const insertCharge = (id: string, createdAt: Date = OLD) =>
  h.db
    .insertInto('charges')
    .values({
      id,
      reference: `ref-${id}`,
      amount: 1000,
      currency: 'VND',
      status: 'SUCCEEDED',
      failure_code: null,
      scenario: '{}',
      metadata: null,
      due_at: createdAt,
      created_at: createdAt,
      completed_at: createdAt,
    })
    .execute();

const insertEvent = async (
  eventId: string,
  status: 'PENDING' | 'DELIVERED' | 'FAILED',
  at: Date,
  attempts = 0,
) => {
  await insertCharge(`ch-${eventId}`, at);
  await h.db
    .insertInto('webhook_events')
    .values({
      event_id: eventId,
      charge_id: `ch-${eventId}`,
      event_type: 'charge.succeeded',
      payload: '{}',
      status,
      attempts,
      next_attempt_at: status === 'PENDING' ? at : null,
      send_twice: false,
      created_at: at,
      delivered_at: status === 'DELIVERED' ? at : null,
    })
    .execute();
  for (let no = 1; no <= attempts; no += 1) {
    await h.db
      .insertInto('webhook_attempts')
      .values({
        event_id: eventId,
        attempt_no: no,
        attempted_at: at,
        status_code: 200,
        error_message: null,
      })
      .execute();
  }
};

const attemptEventIds = async () =>
  [
    ...new Set(
      (await h.db.selectFrom('webhook_attempts').select('event_id').execute()).map(
        (r) => r.event_id,
      ),
    ),
  ].sort();

const eventIds = async () =>
  (await h.db.selectFrom('webhook_events').select('event_id').execute())
    .map((r) => r.event_id)
    .sort();

describe('webhook_attempts', () => {
  it('deletes attempts of old DELIVERED events only', async () => {
    await insertEvent('del-old', 'DELIVERED', OLD, 2);
    await insertEvent('del-young', 'DELIVERED', YOUNG, 2);
    await insertEvent('pend-old', 'PENDING', OLD, 2);
    await insertEvent('fail-old', 'FAILED', OLD, 2);

    expect(await purge('webhook_attempts')).toBe(2);
    expect(await attemptEventIds()).toEqual(['del-young', 'fail-old', 'pend-old']);
    expect(await purge('webhook_attempts')).toBe(0);
  });
});

describe('webhook_events', () => {
  it('deletes an old DELIVERED event only once its attempts are gone', async () => {
    await insertEvent('del-old', 'DELIVERED', OLD, 1);
    await insertEvent('del-bare', 'DELIVERED', OLD, 0);
    await insertEvent('del-young', 'DELIVERED', YOUNG, 0);
    await insertEvent('pend-old', 'PENDING', OLD, 0);
    await insertEvent('fail-old', 'FAILED', OLD, 0);

    // Chỉ sự kiện không có attempt nào đủ điều kiện; sự kiện còn attempt thì chưa xóa được.
    expect(await purge('webhook_events')).toBe(1);
    expect(await eventIds()).toEqual(['del-old', 'del-young', 'fail-old', 'pend-old']);
    expect(await purge('webhook_events')).toBe(0);

    expect(await purge('webhook_attempts')).toBe(1);
    expect(await purge('webhook_events')).toBe(1);
    expect(await eventIds()).toEqual(['del-young', 'fail-old', 'pend-old']);
  });
});

describe('idempotency_keys', () => {
  it('deletes only aged keys and leaves the charges they point to', async () => {
    await insertCharge('c-old');
    await insertCharge('c-young', YOUNG);
    await h.db
      .insertInto('idempotency_keys')
      .values([
        key('k-old', 'c-old', OLD),
        key('k-old2', 'c-old', OLD),
        key('k-young', 'c-young', YOUNG),
      ])
      .execute();
    const chargesBefore = await countOf('charges');

    expect(await purge('idempotency_keys')).toBe(2);

    const left = await h.db.selectFrom('idempotency_keys').select('idempotency_key').execute();
    expect(left.map((r) => r.idempotency_key)).toEqual(['k-young']);
    expect(await countOf('charges')).toBe(chargesBefore);
  });
});

function key(idempotencyKey: string, chargeId: string, createdAt: Date) {
  return {
    idempotency_key: idempotencyKey,
    request_hash: 'h',
    response_status: 202,
    response_body: '{}',
    charge_id: chargeId,
    created_at: createdAt,
  };
}

const seedAgedKeys = async (prefix: string, count: number) => {
  await insertCharge(`c-${prefix}`);
  await h.db
    .insertInto('idempotency_keys')
    .values(Array.from({ length: count }, (_, i) => key(`${prefix}-${i}`, `c-${prefix}`, OLD)))
    .execute();
};

describe('batching and dry-run', () => {
  it('honours the batch size (TOP)', async () => {
    await seedAgedKeys('batch', 25);
    expect(await purge('idempotency_keys', { batch: 10 })).toBe(10);
    expect(await purge('idempotency_keys', { batch: 10 })).toBe(10);
    expect(await purge('idempotency_keys', { batch: 10 })).toBe(5);
    expect(await purge('idempotency_keys', { batch: 10 })).toBe(0);
  });

  it('counts without deleting in dry-run, regardless of the batch size', async () => {
    await seedAgedKeys('dry', 25);
    expect(await purge('idempotency_keys', { batch: 10, dryRun: true })).toBe(25);
    expect(await countOf('idempotency_keys')).toBe(25);
    expect(await purge('webhook_attempts', { dryRun: true })).toBe(0);
  });

  it('counts the same rows in dry-run as the real run deletes', async () => {
    await insertEvent('dr-del', 'DELIVERED', OLD, 3);
    await insertEvent('dr-pend', 'PENDING', OLD, 3);
    expect(await purge('webhook_attempts', { dryRun: true })).toBe(3);
    expect(await countOf('webhook_attempts')).toBe(6);
    expect(await purge('webhook_attempts')).toBe(3);
  });
});

describe('safety', () => {
  it('never touches charges, even with a far-future cutoff', async () => {
    await insertEvent('fin-1', 'DELIVERED', OLD, 2);
    await insertEvent('fin-2', 'DELIVERED', OLD, 0);
    await insertEvent('fin-3', 'PENDING', OLD, 1);
    await h.db
      .insertInto('idempotency_keys')
      .values(key('k-fin', 'ch-fin-1', OLD))
      .execute();
    const before = await countOf('charges');
    expect(before).toBeGreaterThan(0);

    for (const policy of PAYMENT_RETENTION_POLICIES) {
      await purgeAll(policy, { cutoff: FAR_FUTURE });
    }

    expect(await countOf('charges')).toBe(before);
    // Chỉ sự kiện PENDING (cùng attempt của nó) còn lại.
    expect(await eventIds()).toEqual(['fin-3']);
    expect(await countOf('webhook_attempts')).toBe(1);
    expect(await countOf('idempotency_keys')).toBe(0);
  });

  it('keeps the policy list in foreign-key order and out of the charges table', () => {
    expect(PAYMENT_RETENTION_POLICIES).toEqual([
      'webhook_attempts',
      'webhook_events',
      'idempotency_keys',
    ]);
    expect(Object.keys(RETENTION_TARGET_TABLES)).toEqual([...PAYMENT_RETENTION_POLICIES]);
    expect(Object.values(RETENTION_TARGET_TABLES).flat()).not.toContain('charges');
  });

  it('survives two concurrent purges without deadlock and deletes each row once', async () => {
    await seedAgedKeys('par', 200);
    const results = await Promise.all([purgeAll('idempotency_keys'), purgeAll('idempotency_keys')]);
    expect(results[0] + results[1]).toBe(200);
    expect(await countOf('idempotency_keys')).toBe(0);
  });
});
