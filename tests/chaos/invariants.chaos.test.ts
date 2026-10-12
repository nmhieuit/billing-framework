import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSystemInvariants,
  collectViolations,
  explainedByMissingAtWallet,
  InvariantViolationError,
  isMissingAtWallet,
  type InvariantId,
  type Violation,
} from './support/invariants.js';
import { killSessions } from './support/sql-faults.js';
import { createSystem, type System } from './support/system-harness.js';

/**
 * Test của oracle bất biến INV-1..INV-4.
 *
 * Phần 1: hệ chạy bình thường (mở ví, nạp, trả đơn, bị từ chối, đảo một lần, điều chỉnh) thì oracle KHÔNG báo gì.
 * Phần 2 (test "oracle"): làm hỏng trạng thái bằng SQL trực tiếp qua kết nối quản trị và chứng minh oracle bắt đúng
 * bất biến bị vi phạm, nêu đúng id, và KHÔNG báo oan bất biến khác.
 *
 * Những gì SQL KHÔNG thể làm hỏng: `ledger_entries` và `ledger_transactions` có trigger `instead of update, delete`
 * (migration 001) nên không thể sửa/xoá dòng sổ cái để tạo lệch (ví dụ đổi `amount` của một dòng). Ta cố ý KHÔNG tắt
 * trigger (disable trigger) vì trạng thái đó sản phẩm không thể đạt được. Vì vậy:
 *  - lỗi liên quan sổ cái được tạo bằng cách CHÈN thêm dòng/giao dịch mới (có chủ ý, kèm cập nhật số dư để các bất biến
 *    không liên quan vẫn đúng), và các ca này dùng hệ riêng vì không thể hoàn tác (không xoá được dòng đã chèn);
 *  - các bảng cho phép sửa (accounts.balance, topups, order_payments, outbox, charges, idempotency_keys) được sửa rồi hoàn tác.
 */

type Db = Kysely<unknown>;

interface Seed {
  /** Đơn alice đã trả (acme), còn nguyên. */
  paid: { orderId: string; transactionId: string; messageId: string };
  /** Đơn bị từ chối vì ví không tồn tại: có OrderPaymentFailedV1 đã tới Orders giả. */
  rejected: { orderId: string; outboxId: string };
  /** Đơn bị đảo rồi giao lại (CONFLICT) và đơn đã trả được giao lại + ops replay (rỗng ở seed nhẹ). */
  redelivery: { reversedOrderId: string; replayedOrderId: string };
  /** Hai lần nạp SUCCEEDED của alice. */
  topups: Array<{ id: string; chargeId: string; accountId: string; transactionId: string }>;
}

const run = async (db: Db, query: ReturnType<typeof sql>): Promise<void> => {
  await query.execute(db);
};

const invariantsOf = (violations: ReadonlyArray<{ invariant: InvariantId }>): InvariantId[] =>
  [...new Set(violations.map((v) => v.invariant))].sort();

/** Dựng một hệ sạch rồi nạp dữ liệu để mọi bất biến có cái để so: ví, nạp tiền, trả đơn, đơn bị từ chối, đảo, điều chỉnh. */
async function seed(s: System, options: { light?: boolean } = {}): Promise<Seed> {
  await s.openWallet('acme', 'alice');
  expect((await s.topup('acme', 'alice', 100_000, 'k-a1')).status).toBe(202);
  if (options.light !== true) {
    await s.openWallet('acme', 'bob');
    await s.openWallet('beta', 'carol');
    expect((await s.topup('acme', 'alice', 50_000, 'k-a2')).status).toBe(202);
    expect((await s.topup('acme', 'bob', 80_000, 'k-b1')).status).toBe(202);
    expect((await s.topup('beta', 'carol', 60_000, 'k-c1')).status).toBe(202);
  }
  await s.heal();

  const paid = await s.sendOrder({ tenant: 'acme', customer: 'alice', amount: 30_000 });
  let rejectedOrderId = '';
  let reversedOrderId = '';
  let replayedOrderId = '';
  if (options.light !== true) {
    const bobOrder = await s.sendOrder({ tenant: 'acme', customer: 'bob', amount: 20_000 });
    await s.sendOrder({ tenant: 'beta', customer: 'carol', amount: 10_000 });
    rejectedOrderId = (await s.sendOrder({ tenant: 'acme', customer: 'ghost', amount: 5_000 }))
      .orderId;
    await s.heal();

    // Đảo một lần bằng ops (khoản trả của bob) và một điều chỉnh (cộng cho alice).
    const bobTx = await sql<{ wallet_transaction_id: string }>`
      select wallet_transaction_id from t_acme.order_payments where order_id = ${bobOrder.orderId}`.execute(
      s.walletAdmin,
    );
    const bobTxId = bobTx.rows[0]?.wallet_transaction_id as string;
    expect(
      (
        await s.ops('acme', `/ops/transactions/${bobTxId}/reversals`, {
          reason: 'chaos oracle seed',
          idempotencyKey: 'seed-reverse-1',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await s.ops('acme', '/ops/wallets/alice/adjustments', {
          reason: 'chaos oracle seed',
          idempotencyKey: 'seed-adjust-1',
          direction: 'CREDIT',
          amount: 1_000,
          currency: 'VND',
        })
      ).status,
    ).toBe(201);
    await s.heal();

    // Các đường giao lại mà chaos sẽ tạo ra (đều phải KHÔNG bị oracle báo):
    //  (c) đơn đã bị đảo được giao lại → wallet từ chối CONFLICT, không ghi nợ lại;
    //  (a) đơn đã trả được giao lại cùng orderId với eventId MỚI → PayOrder REPLAYED, OrderPaidV1 thứ hai (messageId mới);
    //  (b) ops REPLAY_PAID → OrderPaidV1 thứ ba, giữ eventId gốc (đơn phải do PayOrder hiện tại trả để có paid_event_id).
    reversedOrderId = bobOrder.orderId;
    await s.sendOrder({
      tenant: 'acme',
      customer: 'bob',
      orderId: reversedOrderId,
      amount: 20_000,
    });
    const second = await s.sendOrder({ tenant: 'acme', customer: 'alice', amount: 4_000 });
    replayedOrderId = second.orderId;
    await s.heal();
    await s.sendOrder({
      tenant: 'acme',
      customer: 'alice',
      orderId: replayedOrderId,
      amount: 4_000,
    });
    await s.heal();
    expect(
      (
        await s.ops('acme', `/ops/orders/${replayedOrderId}/replay-paid`, {
          reason: 'chaos oracle seed',
          idempotencyKey: 'seed-replay-1',
        })
      ).status,
    ).toBe(202);
  }
  await s.heal();

  const paidTx = await sql<{ wallet_transaction_id: string }>`
    select wallet_transaction_id from t_acme.order_payments where order_id = ${paid.orderId}`.execute(
    s.walletAdmin,
  );
  const received = s.orders.received().find((r) => r.payload.orderId === paid.orderId);
  const failed =
    rejectedOrderId === ''
      ? { rows: [] as Array<{ id: string }> }
      : await sql<{ id: string }>`
          select id from t_acme.outbox
          where event_type = 'OrderPaymentFailedV1' and json_value(payload, '$.orderId') = ${rejectedOrderId}`.execute(
          s.walletAdmin,
        );
  const topups = await sql<{ id: string; charge_id: string; account_id: string; tx: string }>`
    select t.id, t.charge_id, t.account_id, x.id as tx
    from t_acme.topups t join t_acme.ledger_transactions x on x.business_key = concat('topup:', t.id)
    where t.customer_id = 'alice' and t.status = 'SUCCEEDED' order by t.created_at, t.id`.execute(
    s.walletAdmin,
  );
  return {
    paid: {
      orderId: paid.orderId,
      transactionId: paidTx.rows[0]?.wallet_transaction_id as string,
      messageId: received?.messageId as string,
    },
    rejected: { orderId: rejectedOrderId, outboxId: failed.rows[0]?.id ?? '' },
    redelivery: { reversedOrderId, replayedOrderId },
    topups: topups.rows.map((t) => ({
      id: t.id,
      chargeId: t.charge_id,
      accountId: t.account_id,
      transactionId: t.tx,
    })),
  };
}

/** Xác nhận oracle báo ĐÚNG tập bất biến mong đợi (không báo oan cái khác) và thông báo nêu các id cụ thể. */
async function expectViolations(
  s: System,
  expected: InvariantId[],
  fragments: string[],
): Promise<void> {
  const violations = await collectViolations(s);
  expect(invariantsOf(violations), violations.map((v) => v.message).join('\n')).toEqual(expected);
  const error = await assertSystemInvariants(s).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InvariantViolationError);
  const thrown = error as InvariantViolationError;
  expect(invariantsOf(thrown.violations)).toEqual(expected);
  for (const fragment of fragments) {
    // Phần tử dạng `code:XYZ` kiểm tra mã vi phạm ổn định; còn lại là đoạn thông báo (id cụ thể).
    if (fragment.startsWith('code:')) {
      const code = fragment.slice('code:'.length);
      expect(
        violations.map((v) => v.code),
        `thiếu mã ${code}`,
      ).toContain(code);
      expect(thrown.violations.map((v) => v.code)).toContain(code);
      continue;
    }
    expect(thrown.message, `thiếu "${fragment}" trong thông báo`).toContain(fragment);
    expect(thrown.violations.map((v) => v.message).join('\n')).toContain(fragment);
  }
}

/** Làm hỏng → kiểm tra oracle → luôn hoàn tác → xác nhận hệ sạch trở lại (để ca sau không bị lẫn). */
async function corrupted(
  s: System,
  apply: () => Promise<void>,
  restore: () => Promise<void>,
  expected: InvariantId[],
  fragments: string[],
): Promise<void> {
  try {
    await apply();
    await expectViolations(s, expected, fragments);
  } finally {
    await restore();
  }
  await assertSystemInvariants(s);
}

async function withFreshSystem(
  light: boolean,
  fn: (s: System, data: Seed) => Promise<void>,
): Promise<void> {
  const s = await createSystem({ seed: 7, tenants: ['acme', 'beta'] });
  try {
    await fn(s, await seed(s, { light }));
  } finally {
    await s.stop();
  }
}

const now = sql`cast(sysutcdatetime() as datetime2(3))`;

// ---------------------------------------------------------------------------------------------------------------------
// Hệ dùng chung: ca bình thường và các ca làm hỏng có hoàn tác
// ---------------------------------------------------------------------------------------------------------------------

let system: System | undefined;
let data: Seed | undefined;

const sys = (): System => {
  if (system === undefined) throw new Error('hệ thống chưa dựng xong');
  return system;
};
const seeded = (): Seed => {
  if (data === undefined) throw new Error('dữ liệu mẫu chưa dựng xong');
  return data;
};

beforeAll(async () => {
  system = await createSystem({ seed: 7, tenants: ['acme', 'beta'] });
  data = await seed(system);
});

afterAll(async () => {
  await system?.stop();
});

describe('oracle INV-1..INV-4 trên hệ chạy bình thường', () => {
  it('does not throw after wallets, topups, paid and rejected orders, one reversal and one adjustment', async () => {
    const s = sys();
    const d = seeded();
    // Bảo đảm dữ liệu mẫu thật sự có đủ loại: oracle không "đạt" vì hệ rỗng.
    expect(d.topups).toHaveLength(2);
    expect(d.rejected.outboxId).not.toBe('');
    const kinds = await sql<{ kind: string }>`
      select distinct kind from t_acme.ledger_transactions`.execute(s.walletAdmin);
    expect(kinds.rows.map((r) => r.kind).sort()).toEqual([
      'ADJUSTMENT',
      'ORDER_PAYMENT',
      'REVERSAL',
      'TOPUP',
    ]);
    expect(await collectViolations(s)).toEqual([]);
    await expect(
      assertSystemInvariants(s, { only: ['INV-1', 'INV-2', 'INV-3', 'INV-4'] }),
    ).resolves.toBeUndefined();
  });

  it('stays clean through redelivery of a paid order (new eventId), an ops replay and a redelivered reversed order', async () => {
    const s = sys();
    const { replayedOrderId, reversedOrderId } = seeded().redelivery;
    expect(replayedOrderId).not.toBe('');

    // (a)+(b): ba OrderPaidV1 cho cùng một đơn (gốc, giao lại với eventId mới, ops replay) — cùng giao dịch ví.
    const paidEvents = s.orders
      .received()
      .filter((r) => r.eventType === 'OrderPaidV1' && r.payload.orderId === replayedOrderId);
    expect(paidEvents).toHaveLength(3);
    expect(new Set(paidEvents.map((e) => e.messageId)).size).toBe(3);
    expect(new Set(paidEvents.map((e) => e.payload.walletTransactionId)).size).toBe(1);
    expect(new Set(paidEvents.map((e) => e.payload.amount))).toEqual(new Set([4_000]));
    // eventId: giao lại sinh eventId mới, ops replay giữ eventId gốc ⇒ đúng hai eventId khác nhau.
    expect(new Set(paidEvents.map((e) => e.payload.eventId)).size).toBe(2);

    // (c): đơn đã bị đảo giao lại ⇒ OrderPaymentFailedV1 CONFLICT, và không có OrderPaidV1 thứ hai.
    const reversedEvents = s.orders.received().filter((r) => r.payload.orderId === reversedOrderId);
    expect(reversedEvents.filter((e) => e.eventType === 'OrderPaidV1')).toHaveLength(1);
    const conflicts = reversedEvents.filter((e) => e.eventType === 'OrderPaymentFailedV1');
    expect(conflicts.map((e) => e.payload.reason)).toEqual(['CONFLICT']);

    await expect(assertSystemInvariants(s)).resolves.toBeUndefined();
  });

  it('refuses invariants it does not implement yet and a system without tenants (no vacuous pass)', async () => {
    const s = sys();
    await expect(collectViolations(s, { only: ['INV-5'] })).rejects.toThrow(/INV-5/);
    // DB payment không có schema t_<tenant>: coi như hệ rỗng.
    await expect(collectViolations({ ...s, walletAdmin: s.paymentAdmin })).rejects.toThrow(
      /không tìm thấy tenant/,
    );
  });

  it('throws when a query fails instead of reading it as a pass', async () => {
    const s = sys();
    // Kết nối giả: mọi truy vấn (kể cả lần thử lại duy nhất của adminQuery) đều lỗi.
    // (Kysely đã destroy() vẫn tự dựng lại pool, và kết nối tới DB không tồn tại treo rất lâu, nên không dùng các cách đó.)
    const broken = {
      getExecutor: () => {
        throw new Error('kết nối quản trị hỏng');
      },
    } as unknown as Kysely<unknown>;
    await expect(
      collectViolations({ ...s, paymentAdmin: broken }, { only: ['INV-3'] }),
    ).rejects.toThrow(/kết nối quản trị hỏng/);
    await expect(collectViolations({ ...s, walletAdmin: broken })).rejects.toThrow(
      /kết nối quản trị hỏng/,
    );
  });

  it('tolerates the admin connection failing once per query (adminQuery retry), yet still sees corruption', async () => {
    const s = sys();
    const flaky = (real: Kysely<unknown>): Kysely<unknown> => {
      let calls = 0;
      return {
        getExecutor: () => {
          calls += 1;
          if (calls % 2 === 1) throw new Error('mất kết nối một lần');
          return real.getExecutor();
        },
      } as unknown as Kysely<unknown>;
    };
    const flakySystem = {
      ...s,
      walletAdmin: flaky(s.walletAdmin),
      paymentAdmin: flaky(s.paymentAdmin),
    };
    expect(await collectViolations(flakySystem)).toEqual([]);
    const account = seeded().topups[0]?.accountId as string;
    await run(
      s.walletAdmin,
      sql`update t_acme.accounts set balance = balance + 1 where id = ${account}`,
    );
    try {
      expect(invariantsOf(await collectViolations(flakySystem))).toEqual(['INV-1']);
    } finally {
      await run(
        s.walletAdmin,
        sql`update t_acme.accounts set balance = balance - 1 where id = ${account}`,
      );
    }
  });

  it('keeps ledger immutability: ledger rows cannot be corrupted by update/delete, so negatives insert instead', async () => {
    const s = sys();
    await expect(
      sql`update t_acme.ledger_entries set amount = amount + 1 where id = (select min(id) from t_acme.ledger_entries)`.execute(
        s.walletAdmin,
      ),
    ).rejects.toThrow(/ledger is immutable/);
    await expect(
      sql`delete from t_acme.ledger_transactions`.execute(s.walletAdmin),
    ).rejects.toThrow(/ledger is immutable/);
    await assertSystemInvariants(s);
  });
});

describe('oracle INV-1: sổ cái cân bằng (làm hỏng có hoàn tác)', () => {
  it('detects total balance != 0 and balance != sum of entries on one wallet', async () => {
    const s = sys();
    const account = seeded().topups[0]?.accountId as string;
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance + 1 where id = ${account}`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance - 1 where id = ${account}`,
        ),
      ['INV-1'],
      [
        'tenant acme',
        account,
        'tổng số dư mọi tài khoản VND = 1',
        'code:TOTAL_NONZERO',
        'code:BALANCE_DRIFT',
      ],
    );
  });

  it('detects balance drift even when the total still nets to zero', async () => {
    const s = sys();
    const account = seeded().topups[0]?.accountId as string;
    const adjustment = 'system:ADJUSTMENT:VND';
    await corrupted(
      s,
      async () => {
        await run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance + 7 where id = ${account}`,
        );
        await run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance - 7 where id = ${adjustment}`,
        );
      },
      async () => {
        await run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance - 7 where id = ${account}`,
        );
        await run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance + 7 where id = ${adjustment}`,
        );
      },
      ['INV-1'],
      ['số dư lệch tổng các dòng sổ cái', account, adjustment, 'code:BALANCE_DRIFT'],
    );
  });

  it('does not blame another tenant when only tenant beta drifts', async () => {
    const s = sys();
    const account = 'wallet:carol';
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_beta.accounts set balance = balance + 3 where id = ${account}`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_beta.accounts set balance = balance - 3 where id = ${account}`,
        ),
      ['INV-1'],
      ['tenant beta', account, 'code:BALANCE_DRIFT', 'code:TOTAL_NONZERO'],
    );
    const violations = await collectViolations(s, { only: ['INV-1'] });
    expect(violations).toEqual([]);
  });
});

describe('oracle INV-2: một đơn chỉ ghi nợ một lần (làm hỏng có hoàn tác)', () => {
  it('detects an order_payments amount that disagrees with the ledger debit', async () => {
    const s = sys();
    const { orderId } = seeded().paid;
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.order_payments set amount = amount + 1 where order_id = ${orderId}`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.order_payments set amount = amount - 1 where order_id = ${orderId}`,
        ),
      ['INV-2'],
      ['lệch số tiền/đồng tiền so với sổ cái', orderId, 'code:ORDER_PAYMENT_AMOUNT_MISMATCH'],
    );
  });

  it('detects an order_payments row pointing at a transaction that is not that order’s ORDER_PAYMENT', async () => {
    const s = sys();
    const { orderId, transactionId } = seeded().paid;
    const topupTx = seeded().topups[0]?.transactionId as string;
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.order_payments set wallet_transaction_id = ${topupTx} where order_id = ${orderId}`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.order_payments set wallet_transaction_id = ${transactionId} where order_id = ${orderId}`,
        ),
      ['INV-2'],
      [orderId, topupTx, transactionId, 'code:ORDER_PAYMENT_MISPLACED'],
    );
  });

  it('detects two OrderPaidV1 at Orders that disagree on walletTransactionId', async () => {
    const s = sys();
    const { orderId } = seeded().paid;
    const results = s.orders.results;
    const original = results.find((r) => r.body.orderId === orderId);
    const before = results.length;
    await corrupted(
      s,
      async () => {
        results.push({
          type: 'OrderPaidV1',
          messageId: 'chaos-fake-paid-1',
          body: { ...(original?.body ?? {}), walletTransactionId: 'bogus-wallet-tx' },
        });
      },
      async () => {
        results.length = before;
      },
      ['INV-2'],
      [orderId, 'chaos-fake-paid-1', 'bogus-wallet-tx', 'code:RECEIVED_PAID_MISMATCH'],
    );
  });

  it('detects an OrderPaidV1 at Orders whose amount differs from the paid amount', async () => {
    const s = sys();
    const { orderId } = seeded().paid;
    const results = s.orders.results;
    const original = results.find((r) => r.body.orderId === orderId);
    const before = results.length;
    await corrupted(
      s,
      async () => {
        results.push({
          type: 'OrderPaidV1',
          messageId: 'chaos-fake-paid-2',
          body: { ...(original?.body ?? {}), amount: 29_999 },
        });
      },
      async () => {
        results.length = before;
      },
      ['INV-2'],
      [orderId, 'chaos-fake-paid-2', '29999', 'code:RECEIVED_PAID_MISMATCH'],
    );
  });
});

describe('oracle INV-3: nạp tiền khớp payment (làm hỏng có hoàn tác)', () => {
  const insertTopup = (s: System, id: string, accountId: string, status: string) =>
    run(
      s.walletAdmin,
      sql`insert into t_acme.topups (id, customer_id, account_id, amount, currency, status, charge_id, attempts, created_at)
          values (${id}, 'alice', ${accountId}, 7000, 'VND', ${status}, 'ch_chaos_bogus', 0, ${now})`,
    );

  it('detects a PENDING topup turned SUCCEEDED without a TOPUP ledger transaction', async () => {
    const s = sys();
    const accountId = seeded().topups[0]?.accountId as string;
    await corrupted(
      s,
      async () => {
        await insertTopup(s, 'chaos-topup-1', accountId, 'PENDING');
        await run(
          s.walletAdmin,
          sql`update t_acme.topups set status = 'SUCCEEDED', completed_at = ${now} where id = 'chaos-topup-1'`,
        );
      },
      () => run(s.walletAdmin, sql`delete from t_acme.topups where id = 'chaos-topup-1'`),
      ['INV-3'],
      ['tenant acme', 'không có giao dịch TOPUP', 'chaos-topup-1', 'code:TOPUP_TX_MISSING'],
    );
  });

  it('detects an extra SUCCEEDED charge on the payment side', async () => {
    const s = sys();
    await corrupted(
      s,
      () =>
        run(
          s.paymentAdmin,
          sql`insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at, completed_at, metadata)
              values ('ch_chaos_extra', 'chaos-ref', 12345, 'VND', 'SUCCEEDED', '{}', ${now}, ${now}, ${now}, '{"tenantId":"acme"}')`,
        ),
      () => run(s.paymentAdmin, sql`delete from charges where id = 'ch_chaos_extra'`),
      ['INV-3'],
      [
        'ch_chaos_extra',
        'tenant acme',
        '12345',
        'không có topup SUCCEEDED khớp',
        'tổng TOPUP trong sổ cái',
        'code:CHARGE_WITHOUT_TOPUP',
        'code:SUM_MISMATCH',
      ],
    );
    // `only` thật sự giới hạn phạm vi: bất biến khác không bị kéo vào khi chỉ hỏi INV-1.
    await run(
      s.paymentAdmin,
      sql`insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at, completed_at, metadata)
          values ('ch_chaos_extra', 'chaos-ref', 12345, 'VND', 'SUCCEEDED', '{}', ${now}, ${now}, ${now}, '{"tenantId":"acme"}')`,
    );
    try {
      expect(await collectViolations(s, { only: ['INV-1', 'INV-2', 'INV-4'] })).toEqual([]);
      expect(invariantsOf(await collectViolations(s, { only: ['INV-3'] }))).toEqual(['INV-3']);
    } finally {
      await run(s.paymentAdmin, sql`delete from charges where id = 'ch_chaos_extra'`);
    }
  });

  it('detects a SUCCEEDED topup whose charge is not SUCCEEDED at payment (wallet credited, gateway did not)', async () => {
    const s = sys();
    const topup = seeded().topups[0] as Seed['topups'][number];
    await corrupted(
      s,
      () =>
        run(
          s.paymentAdmin,
          sql`update charges set status = 'FAILED', failure_code = 'x' where id = ${topup.chargeId}`,
        ),
      () =>
        run(
          s.paymentAdmin,
          sql`update charges set status = 'SUCCEEDED', failure_code = null where id = ${topup.chargeId}`,
        ),
      ['INV-3'],
      [
        'không có charge SUCCEEDED khớp bên payment',
        topup.id,
        topup.chargeId,
        'tổng TOPUP trong sổ cái',
        'code:TOPUP_CHARGE_NOT_SUCCEEDED',
        'code:SUM_MISMATCH',
      ],
    );
  });

  it('detects a TOPUP ledger transaction whose topup is no longer SUCCEEDED', async () => {
    const s = sys();
    const topup = seeded().topups[1] as Seed['topups'][number];
    await corrupted(
      s,
      () =>
        run(s.walletAdmin, sql`update t_acme.topups set status = 'PENDING' where id = ${topup.id}`),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.topups set status = 'SUCCEEDED' where id = ${topup.id}`,
        ),
      ['INV-3'],
      [
        'giao dịch TOPUP không thuộc topup SUCCEEDED nào',
        topup.transactionId,
        topup.id,
        'code:TX_WITHOUT_SUCCEEDED_TOPUP',
        'code:CHARGE_TOPUP_NOT_SUCCEEDED',
      ],
    );
  });

  it('detects a topup amount that disagrees with the TOPUP transaction and the charge', async () => {
    const s = sys();
    const topup = seeded().topups[0] as Seed['topups'][number];
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.topups set amount = amount + 1 where id = ${topup.id}`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.topups set amount = amount - 1 where id = ${topup.id}`,
        ),
      ['INV-3'],
      [
        'số tiền topup lệch giao dịch TOPUP',
        topup.id,
        topup.chargeId,
        'code:TOPUP_TX_AMOUNT_MISMATCH',
      ],
    );
  });

  it('detects two topups sharing one charge_id', async () => {
    const s = sys();
    const [first, second] = seeded().topups as [Seed['topups'][number], Seed['topups'][number]];
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.topups set charge_id = ${first.chargeId} where id = ${second.id}`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.topups set charge_id = ${second.chargeId} where id = ${second.id}`,
        ),
      ['INV-3'],
      [
        'charge_id gắn cho nhiều topup',
        first.chargeId,
        `acme/${first.id}`,
        `acme/${second.id}`,
        'code:DUPLICATE_CHARGE_ID',
      ],
    );
  });

  it('detects a second charge for the same reference even when it did not succeed', async () => {
    const s = sys();
    const topup = seeded().topups[0] as Seed['topups'][number];
    await corrupted(
      s,
      () =>
        run(
          s.paymentAdmin,
          sql`insert into charges (id, reference, amount, currency, status, failure_code, scenario, due_at, created_at, completed_at, metadata)
              values ('ch_chaos_dupe', ${topup.id}, 7000, 'VND', 'FAILED', 'x', '{}', ${now}, ${now}, ${now}, '{"tenantId":"acme"}')`,
        ),
      () => run(s.paymentAdmin, sql`delete from charges where id = 'ch_chaos_dupe'`),
      ['INV-3'],
      [
        'nhiều charge cho cùng một reference',
        topup.id,
        'ch_chaos_dupe',
        topup.chargeId,
        'code:DUPLICATE_CHARGE_REF',
      ],
    );
  });

  it('detects one charge holding two idempotency keys', async () => {
    const s = sys();
    const topup = seeded().topups[0] as Seed['topups'][number];
    await corrupted(
      s,
      () =>
        run(
          s.paymentAdmin,
          sql`insert into idempotency_keys (idempotency_key, request_hash, response_status, response_body, charge_id, created_at)
              values ('chaos-extra-key', 'h', 202, '{}', ${topup.chargeId}, ${now})`,
        ),
      () =>
        run(
          s.paymentAdmin,
          sql`delete from idempotency_keys where idempotency_key = 'chaos-extra-key'`,
        ),
      ['INV-3'],
      [
        'charge có nhiều idempotency key',
        topup.chargeId,
        'chaos-extra-key',
        'code:CHARGE_MULTIPLE_KEYS',
      ],
    );
  });
});

describe('oracle INV-4: outbox và Orders giả (làm hỏng có hoàn tác)', () => {
  const insertOutbox = (
    s: System,
    id: string,
    eventType: string,
    payload: string,
    status: string,
  ) =>
    run(
      s.walletAdmin,
      sql`insert into t_acme.outbox (id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at)
          values (${id}, ${eventType}, 'chaos.probe', ${payload}, 'chaos-corr', ${status}, 0,
                  dateadd(year, 1, sysutcdatetime()), ${now})`,
    );
  const deleteOutbox = (s: System, id: string) =>
    run(s.walletAdmin, sql`delete from t_acme.outbox where id = ${id}`);

  it('detects an outbox row that stays PENDING and is never sent', async () => {
    const s = sys();
    await corrupted(
      s,
      () => insertOutbox(s, 'chaos-ob-pending', 'ChaosProbe', '{}', 'PENDING'),
      () => deleteOutbox(s, 'chaos-ob-pending'),
      ['INV-4'],
      ['tenant acme', 'outbox còn dòng chưa SENT', 'chaos-ob-pending', 'code:OUTBOX_NOT_SENT'],
    );
  });

  it('detects an OrderPaidV1 row flipped to SENT (status column only) that Orders never received', async () => {
    const s = sys();
    const { orderId } = seeded().paid;
    await corrupted(
      s,
      async () => {
        await insertOutbox(
          s,
          'chaos-ob-sent',
          'OrderPaidV1',
          JSON.stringify({ orderId }),
          'PENDING',
        );
        await run(
          s.walletAdmin,
          sql`update t_acme.outbox set status = 'SENT', sent_at = ${now} where id = 'chaos-ob-sent'`,
        );
      },
      () => deleteOutbox(s, 'chaos-ob-sent'),
      ['INV-4'],
      [
        'outbox đã SENT nhưng Orders giả chưa nhận',
        'chaos-ob-sent',
        orderId,
        'code:SENT_NOT_RECEIVED',
      ],
    );
  });

  it('detects a paid order whose OrderPaidV1 never reached Orders', async () => {
    const s = sys();
    const { orderId, messageId } = seeded().paid;
    const results = s.orders.results;
    const index = results.findIndex((r) => r.messageId === messageId);
    const removed = results[index];
    expect(removed).toBeDefined();
    await corrupted(
      s,
      async () => {
        results.splice(index, 1);
      },
      async () => {
        results.splice(index, 0, removed as (typeof results)[number]);
      },
      ['INV-4'],
      [
        'đơn đã trả nhưng Orders giả chưa nhận OrderPaidV1',
        orderId,
        messageId,
        'code:PAID_NOT_RECEIVED',
        'code:SENT_NOT_RECEIVED',
      ],
    );
  });

  it('detects a committed PayOrder rejection (OrderPaymentFailedV1) that never reached Orders', async () => {
    const s = sys();
    const { orderId, outboxId } = seeded().rejected;
    const results = s.orders.results;
    const index = results.findIndex((r) => r.messageId === outboxId);
    const removed = results[index];
    expect(removed).toBeDefined();
    await corrupted(
      s,
      async () => {
        results.splice(index, 1);
      },
      async () => {
        results.splice(index, 0, removed as (typeof results)[number]);
      },
      ['INV-4'],
      [
        'outbox đã SENT nhưng Orders giả chưa nhận',
        outboxId,
        'OrderPaymentFailedV1',
        orderId,
        'code:SENT_NOT_RECEIVED',
      ],
    );
  });

  it('detects an OrderPaidV1 delivered to Orders for an order without order_payments', async () => {
    const s = sys();
    const results = s.orders.results;
    const before = results.length;
    await corrupted(
      s,
      async () => {
        results.push({
          type: 'OrderPaidV1',
          messageId: 'chaos-ghost-msg',
          body: {
            tenantId: 'acme',
            orderId: 'chaos-ghost-order',
            walletTransactionId: 'ghost-tx',
            amount: 1,
            currency: 'VND',
          },
        });
      },
      async () => {
        results.length = before;
      },
      ['INV-4'],
      [
        'Orders giả đã nhận OrderPaidV1 cho đơn không có order_payments',
        'chaos-ghost-msg',
        'chaos-ghost-order',
        'code:RECEIVED_PAID_UNKNOWN_ORDER',
      ],
    );
  });

  it('detects an OrderPaidV1 in the outbox for an order without order_payments', async () => {
    const s = sys();
    const results = s.orders.results;
    const before = results.length;
    await corrupted(
      s,
      async () => {
        await insertOutbox(
          s,
          'chaos-ob-ghost',
          'OrderPaidV1',
          JSON.stringify({ orderId: 'chaos-ghost-order-2' }),
          'PENDING',
        );
        await run(
          s.walletAdmin,
          sql`update t_acme.outbox set status = 'SENT', sent_at = ${now} where id = 'chaos-ob-ghost'`,
        );
        // Cho Orders giả "nhận" đúng dòng này để chỉ còn lỗi "đơn không có order_payments".
        results.push({
          type: 'OrderPaidV1',
          messageId: 'chaos-ob-ghost',
          body: {
            tenantId: 'acme',
            orderId: 'chaos-ghost-order-2',
            walletTransactionId: 'g',
            amount: 1,
            currency: 'VND',
          },
        });
      },
      async () => {
        results.length = before;
        await deleteOutbox(s, 'chaos-ob-ghost');
      },
      ['INV-4'],
      [
        'outbox có OrderPaidV1 cho đơn không có order_payments',
        'chaos-ob-ghost',
        'chaos-ghost-order-2',
        'code:OUTBOX_PAID_UNKNOWN_ORDER',
        'code:RECEIVED_PAID_UNKNOWN_ORDER',
      ],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ca làm hỏng không hoàn tác được (chèn dòng sổ cái): mỗi ca một hệ riêng
// ---------------------------------------------------------------------------------------------------------------------

describe('oracle với lỗi chèn vào sổ cái (hệ riêng cho từng ca, không hoàn tác được)', () => {
  const insertTx = (s: System, id: string, key: string, kind: string) =>
    run(
      s.walletAdmin,
      sql`insert into t_acme.ledger_transactions (id, business_key, kind, created_at) values (${id}, ${key}, ${kind}, ${now})`,
    );
  const insertEntry = (s: System, tx: string, account: string, amount: number) =>
    run(
      s.walletAdmin,
      sql`insert into t_acme.ledger_entries (transaction_id, account_id, amount, created_at) values (${tx}, ${account}, ${amount}, ${now})`,
    );
  const bump = (s: System, account: string, delta: number) =>
    run(
      s.walletAdmin,
      sql`update t_acme.accounts set balance = balance + ${delta} where id = ${account}`,
    );

  it('INV-1: detects unbalanced transactions even when balances and totals still agree', async () => {
    await withFreshSystem(true, async (s) => {
      // T1: ví +5 (một dòng); T2: ADJUSTMENT −5 (một dòng). Số dư cập nhật khớp dòng và tổng vẫn 0
      // ⇒ chỉ riêng "tổng dòng của mỗi giao dịch = 0" bị vi phạm.
      await insertTx(s, 'chaos-u1', 'adjustment:chaos-u1', 'ADJUSTMENT');
      await insertEntry(s, 'chaos-u1', 'wallet:alice', 5);
      await insertTx(s, 'chaos-u2', 'adjustment:chaos-u2', 'ADJUSTMENT');
      await insertEntry(s, 'chaos-u2', 'system:ADJUSTMENT:VND', -5);
      await bump(s, 'wallet:alice', 5);
      await bump(s, 'system:ADJUSTMENT:VND', -5);
      await expectViolations(
        s,
        ['INV-1'],
        ['giao dịch có tổng dòng khác 0', 'chaos-u1', 'chaos-u2', 'code:TX_UNBALANCED'],
      );
    });
  });

  it('INV-1: detects a ledger transaction with no entries', async () => {
    await withFreshSystem(true, async (s) => {
      await insertTx(s, 'chaos-empty', 'adjustment:chaos-empty', 'ADJUSTMENT');
      await expectViolations(s, ['INV-1'], ['không có dòng nào', 'chaos-empty', 'code:TX_EMPTY']);
    });
  });

  it('INV-2: detects an orphan ORDER_PAYMENT transaction (balanced, no order_payments row)', async () => {
    await withFreshSystem(true, async (s) => {
      await insertTx(s, 'chaos-orphan', 'order:chaos-orphan-order', 'ORDER_PAYMENT');
      await insertEntry(s, 'chaos-orphan', 'wallet:alice', -1_000);
      await insertEntry(s, 'chaos-orphan', 'system:MERCHANT:VND', 1_000);
      await bump(s, 'wallet:alice', -1_000);
      await bump(s, 'system:MERCHANT:VND', 1_000);
      await expectViolations(
        s,
        ['INV-2'],
        ['không có dòng order_payments', 'chaos-orphan', 'code:ORPHAN_ORDER_TX'],
      );
    });
  });

  it('INV-2: detects a second debit for an already paid order', async () => {
    await withFreshSystem(true, async (s, d) => {
      await insertTx(s, 'chaos-twice', `order:${d.paid.orderId}#2`, 'ORDER_PAYMENT');
      await insertEntry(s, 'chaos-twice', 'wallet:alice', -30_000);
      await insertEntry(s, 'chaos-twice', 'system:MERCHANT:VND', 30_000);
      await bump(s, 'wallet:alice', -30_000);
      await bump(s, 'system:MERCHANT:VND', 30_000);
      await expectViolations(
        s,
        ['INV-2'],
        ['ghi nợ lần hai', 'chaos-twice', d.paid.orderId, 'code:ORPHAN_ORDER_TX'],
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Chịu được việc kết nối quản trị bị giết một lần
// ---------------------------------------------------------------------------------------------------------------------

describe('oracle chịu được kết nối quản trị bị giết', () => {
  it('still evaluates correctly right after killSessions() closed the admin sessions', async () => {
    await withFreshSystem(true, async (s) => {
      expect(await killSessions(s.walletDb)).toBeGreaterThan(0);
      expect(await collectViolations(s)).toEqual([]);
      expect(await killSessions(s.walletDb)).toBeGreaterThan(0);
      await sql`update t_acme.accounts set balance = balance + 1 where id = 'wallet:alice'`
        .execute(s.walletAdmin)
        .catch(() =>
          sql`update t_acme.accounts set balance = balance + 1 where id = 'wallet:alice'`.execute(
            s.walletAdmin,
          ),
        );
      await expectViolations(s, ['INV-1'], ['wallet:alice']);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Phân loại MISSING_AT_WALLET (dùng cho kịch bản S7 ở task sau)
// ---------------------------------------------------------------------------------------------------------------------

const missing = (
  topupStatus: string,
  failureCode: string | null,
  amount = 100,
  tenant = 'acme',
  chargeStatus = 'SUCCEEDED',
): Violation => ({
  invariant: 'INV-3',
  code: 'CHARGE_TOPUP_NOT_SUCCEEDED',
  message: 'x',
  detail: {
    tenant,
    chargeId: 'ch1',
    topupId: 't1',
    topupStatus,
    failureCode,
    chargeStatus,
    amount,
    currency: 'VND',
  },
});
const sumMismatch = (ledger: number, gateway: number, tenant = 'acme'): Violation => ({
  invariant: 'INV-3',
  code: 'SUM_MISMATCH',
  message: 'x',
  detail: { tenant, currency: 'VND', ledger, gateway },
});
const other: Violation = { invariant: 'INV-3', code: 'DUPLICATE_CHARGE_REF', message: 'x' };

describe('isMissingAtWallet / explainedByMissingAtWallet (thuần, không cần hệ)', () => {
  it('flags only charge-succeeded states with a topup still open or failed for PAYMENT_UNAVAILABLE', () => {
    expect(isMissingAtWallet(missing('REQUESTED', null))).toBe(true);
    expect(isMissingAtWallet(missing('PENDING', null))).toBe(true);
    expect(isMissingAtWallet(missing('FAILED', 'PAYMENT_UNAVAILABLE'))).toBe(true);
    expect(isMissingAtWallet(missing('FAILED', 'PAYMENT_REJECTED'))).toBe(false);
    expect(isMissingAtWallet(missing('FAILED', null))).toBe(false);
    expect(isMissingAtWallet(missing('SUCCEEDED', null))).toBe(false);
    expect(isMissingAtWallet(missing('PENDING', null, 100, 'acme', 'FAILED'))).toBe(false);
    expect(isMissingAtWallet({ ...missing('PENDING', null), code: 'CHARGE_WITHOUT_TOPUP' })).toBe(
      false,
    );
    expect(isMissingAtWallet({ ...missing('PENDING', null), invariant: 'INV-1' })).toBe(false);
  });

  it('explains violations only when every one is missing-at-wallet or a sum mismatch matching exactly', () => {
    expect(explainedByMissingAtWallet([missing('PENDING', null), sumMismatch(0, 100)])).toBe(true);
    // Hai charge cùng tenant+đồng tiền: tổng 150.
    expect(
      explainedByMissingAtWallet([
        missing('PENDING', null, 100),
        missing('FAILED', 'PAYMENT_UNAVAILABLE', 50),
        sumMismatch(1_000, 1_150),
      ]),
    ).toBe(true);
    // Khác tenant: mỗi tenant có SUM_MISMATCH riêng.
    expect(
      explainedByMissingAtWallet([
        missing('PENDING', null, 100),
        missing('REQUESTED', null, 70, 'beta'),
        sumMismatch(0, 100),
        sumMismatch(5, 75, 'beta'),
      ]),
    ).toBe(true);

    expect(explainedByMissingAtWallet([])).toBe(false);
    // Số tiền lệch dù chỉ 1 đơn vị.
    expect(explainedByMissingAtWallet([missing('PENDING', null), sumMismatch(0, 101)])).toBe(false);
    expect(explainedByMissingAtWallet([missing('PENDING', null), sumMismatch(0, 99)])).toBe(false);
    // Thiếu SUM_MISMATCH tương ứng, hoặc SUM_MISMATCH không có charge giải thích.
    expect(explainedByMissingAtWallet([missing('PENDING', null)])).toBe(false);
    expect(explainedByMissingAtWallet([sumMismatch(0, 100)])).toBe(false);
    // Một vi phạm không giải thích được làm cả tập thành false.
    expect(explainedByMissingAtWallet([missing('PENDING', null), sumMismatch(0, 100), other])).toBe(
      false,
    );
    expect(
      explainedByMissingAtWallet([
        missing('PENDING', null),
        sumMismatch(0, 100),
        { invariant: 'INV-1', code: 'TX_EMPTY', message: 'x' },
      ]),
    ).toBe(false);
    // Topup FAILED vì lý do khác không phải MISSING_AT_WALLET.
    expect(
      explainedByMissingAtWallet([missing('FAILED', 'PAYMENT_REJECTED'), sumMismatch(0, 100)]),
    ).toBe(false);
  });
});

describe('oracle phân loại MISSING_AT_WALLET trên dữ liệu thật (có hoàn tác)', () => {
  const chargeSql = (id: string, reference: string, amount: number) =>
    sql`insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at, completed_at, metadata)
        values (${id}, ${reference}, ${amount}, 'VND', 'SUCCEEDED', '{}', ${now}, ${now}, ${now}, '{"tenantId":"acme"}')`;

  it('reports structured ids and classifies a charge SUCCEEDED whose topup was never credited', async () => {
    const s = sys();
    const accountId = seeded().topups[0]?.accountId as string;
    const insertTopup = (status: string, failureCode: string | null) =>
      run(
        s.walletAdmin,
        sql`insert into t_acme.topups (id, customer_id, account_id, amount, currency, status, charge_id, failure_code, attempts, created_at)
            values ('chaos-mw-topup', 'alice', ${accountId}, 7000, 'VND', ${status}, null, ${failureCode}, 0, ${now})`,
      );
    try {
      await insertTopup('PENDING', null);
      await run(s.paymentAdmin, chargeSql('ch_chaos_mw', 'chaos-mw-topup', 7000));

      let violations = await collectViolations(s);
      expect(invariantsOf(violations)).toEqual(['INV-3']);
      const charge = violations.find((v) => v.code === 'CHARGE_TOPUP_NOT_SUCCEEDED');
      expect(charge?.detail).toMatchObject({
        tenant: 'acme',
        chargeId: 'ch_chaos_mw',
        topupId: 'chaos-mw-topup',
        chargeStatus: 'SUCCEEDED',
        topupStatus: 'PENDING',
        failureCode: null,
        amount: 7000,
        currency: 'VND',
      });
      const sum = violations.find((v) => v.code === 'SUM_MISMATCH')?.detail;
      expect(sum).toMatchObject({ tenant: 'acme', currency: 'VND' });
      expect((sum?.gateway as number) - (sum?.ledger as number)).toBe(7000);
      expect(violations.filter(isMissingAtWallet)).toHaveLength(1);
      expect(explainedByMissingAtWallet(violations)).toBe(true);

      // FAILED vì PAYMENT_UNAVAILABLE (webhook thành công đến muộn) vẫn là MISSING_AT_WALLET.
      await run(
        s.walletAdmin,
        sql`update t_acme.topups set status = 'FAILED', failure_code = 'PAYMENT_UNAVAILABLE' where id = 'chaos-mw-topup'`,
      );
      violations = await collectViolations(s);
      expect(violations.find((v) => v.code === 'CHARGE_TOPUP_NOT_SUCCEEDED')?.detail).toMatchObject(
        {
          topupStatus: 'FAILED',
          failureCode: 'PAYMENT_UNAVAILABLE',
        },
      );
      expect(explainedByMissingAtWallet(violations)).toBe(true);

      // FAILED vì PAYMENT_REJECTED thì KHÔNG phải MISSING_AT_WALLET.
      await run(
        s.walletAdmin,
        sql`update t_acme.topups set failure_code = 'PAYMENT_REJECTED' where id = 'chaos-mw-topup'`,
      );
      violations = await collectViolations(s);
      expect(violations.some(isMissingAtWallet)).toBe(false);
      expect(explainedByMissingAtWallet(violations)).toBe(false);

      // Thêm một vi phạm không giải thích được (charge không có topup) ⇒ không còn được coi là giải thích hết.
      await run(
        s.walletAdmin,
        sql`update t_acme.topups set failure_code = 'PAYMENT_UNAVAILABLE' where id = 'chaos-mw-topup'`,
      );
      expect(explainedByMissingAtWallet(await collectViolations(s))).toBe(true);
      await run(s.paymentAdmin, chargeSql('ch_chaos_mw2', 'chaos-nowhere', 123));
      violations = await collectViolations(s);
      expect(violations.some((v) => v.code === 'CHARGE_WITHOUT_TOPUP')).toBe(true);
      expect(violations.filter(isMissingAtWallet)).toHaveLength(1);
      expect(explainedByMissingAtWallet(violations)).toBe(false);
    } finally {
      await run(
        s.paymentAdmin,
        sql`delete from charges where id in ('ch_chaos_mw', 'ch_chaos_mw2')`,
      );
      await run(s.walletAdmin, sql`delete from t_acme.topups where id = 'chaos-mw-topup'`);
    }
    await assertSystemInvariants(s);
  });
});
