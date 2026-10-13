import { waitFor } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSystemInvariants,
  collectViolations,
  explainedByMissingAtWallet,
  InvariantViolationError,
  isMissingAtWallet,
  reconcileDaysOf,
  readWalletSnapshot,
  runInvariants,
  reconciliationRunner,
  runReconciliationViaHttp,
  type InvariantId,
  type ReconcileRun,
  type ReconcileRunner,
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
      const failEveryOther = (): void => {
        calls += 1;
        if (calls % 2 === 1) throw new Error('mất kết nối một lần');
      };
      return {
        getExecutor: () => {
          failEveryOther();
          return real.getExecutor();
        },
        // Đọc snapshot phía wallet (readWalletSnapshot) mở transaction; cũng hỏng một lần rồi mới chạy.
        transaction: () => {
          failEveryOther();
          return real.transaction();
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
      // Giao dịch ADJUSTMENT chèn tay không có ops_actions nên INV-6 cũng đúng khi báo chúng là hiệu ứng mồ côi.
      await expectViolations(
        s,
        ['INV-1', 'INV-6'],
        [
          'giao dịch có tổng dòng khác 0',
          'chaos-u1',
          'chaos-u2',
          'code:TX_UNBALANCED',
          'code:ADJUSTMENT_TX_ORPHAN',
        ],
      );
    });
  });

  it('INV-1: detects a ledger transaction with no entries', async () => {
    await withFreshSystem(true, async (s) => {
      await insertTx(s, 'chaos-empty', 'adjustment:chaos-empty', 'ADJUSTMENT');
      await expectViolations(
        s,
        ['INV-1', 'INV-6'],
        ['không có dòng nào', 'chaos-empty', 'code:TX_EMPTY', 'code:ADJUSTMENT_TX_ORPHAN'],
      );
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

// ---------------------------------------------------------------------------------------------------------------------
// INV-4 (e) PAID_WITHOUT_OUTBOX và retention
// ---------------------------------------------------------------------------------------------------------------------

describe('oracle INV-4 (e): đơn đã trả phải còn dòng outbox OrderPaidV1 (trừ khi retention xóa thật)', () => {
  it('detects a paid order whose OrderPaidV1 outbox row vanished, unless retention may have purged it', async () => {
    const s = sys();
    const { orderId } = seeded().paid;
    // Đổi loại sự kiện để dòng "biến mất" khỏi mọi kiểm tra INV-4 khác mà vẫn hoàn tác được (outbox cho phép sửa).
    await run(
      s.walletAdmin,
      sql`update t_acme.outbox set event_type = 'ChaosHidden' where event_type = 'OrderPaidV1' and json_value(payload, '$.orderId') = ${orderId}`,
    );
    try {
      const strict = await collectViolations(s, { only: ['INV-4'] });
      expect(strict.map((v) => v.code)).toEqual(['PAID_WITHOUT_OUTBOX']);
      expect(strict[0]?.message).toContain(orderId);
      // Retention thật có thể đã dọn dòng SENT: cùng dữ liệu, oracle không được báo oan.
      expect(
        await collectViolations({ ...s, retentionDeletes: true }, { only: ['INV-4'] }),
      ).toEqual([]);
    } finally {
      await run(
        s.walletAdmin,
        sql`update t_acme.outbox set event_type = 'OrderPaidV1' where event_type = 'ChaosHidden'`,
      );
    }
    await assertSystemInvariants(s);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// assertSystemInvariants: thứ tự kiểm tra, đối soát thật (INV-5)
// ---------------------------------------------------------------------------------------------------------------------

const today = (): string => new Date().toISOString().slice(0, 10);

/** Bọc runner thật: ghi lại mọi lượt và cho test chèn hiệu ứng phụ / sửa kết quả (hook có thể gọi runReconciliationViaHttp). */
function spyRunner(hook?: ReconcileRunner) {
  const calls: Array<{ tenant: string; day: string; pass: 1 | 2 }> = [];
  const runs: ReconcileRun[] = [];
  const runner: ReconcileRunner = async (sys, tenant, day, pass) => {
    calls.push({ tenant, day, pass });
    const result = await (hook ?? runReconciliationViaHttp)(sys, tenant, day, pass);
    runs.push(result);
    return result;
  };
  return { runner, calls, runs };
}

const emptyRun = (
  tenant: string,
  day: string,
  items: ReconcileRun['items'] = [],
): ReconcileRun => ({
  tenant,
  day,
  runId: 'chaos-fake-run',
  status: 'COMPLETED',
  failureReason: null,
  gatewayTotals: {},
  walletTotals: {},
  items,
});

const fakeItem = (
  kind: string,
  action = 'NONE',
  caseStatus = 'OPEN',
): ReconcileRun['items'][number] => ({
  id: `chaos-fake-item-${kind}`,
  kind,
  chargeId: 'ch_chaos_fake',
  topupId: 'chaos-fake-topup',
  action,
  caseStatus,
  detail: {},
});

const codesOf = (violations: readonly Violation[], invariant?: InvariantId): string[] =>
  violations.filter((v) => invariant === undefined || v.invariant === invariant).map((v) => v.code);

describe('assertSystemInvariants: đối soát thật trên hệ sạch', () => {
  it('reconciles every tenant and data day twice against the real settlement, finds nothing, and is repeatable', async () => {
    const s = sys();
    const spy = spyRunner();
    expect(await runInvariants(s, { reconcileRunner: spy.runner })).toEqual([]);

    const first = spy.calls.filter((c) => c.pass === 1);
    const second = spy.calls.filter((c) => c.pass === 2);
    // 2 tenant × (ngày dữ liệu + ngày liền trước).
    expect(first.length).toBeGreaterThanOrEqual(4);
    expect(second).toHaveLength(first.length);
    expect(new Set(first.map((c) => c.tenant))).toEqual(new Set(['acme', 'beta']));
    expect(new Set(first.map((c) => c.day)).size).toBeGreaterThanOrEqual(2);

    // Đối soát thật: payment (qua /settlements) và wallet cùng thấy đúng số tiền đã nạp (acme 230k, beta 60k).
    const sum = (tenant: string, field: 'gatewayTotals' | 'walletTotals'): number =>
      spy.runs
        .filter((r, index) => r.tenant === tenant && spy.calls[index]?.pass === 1)
        .reduce((total, r) => total + (r[field].VND ?? 0), 0);
    expect(sum('acme', 'gatewayTotals')).toBe(230_000);
    expect(sum('acme', 'walletTotals')).toBe(230_000);
    expect(sum('beta', 'gatewayTotals')).toBe(60_000);
    expect(spy.runs.every((r) => r.status === 'COMPLETED' && r.items.length === 0)).toBe(true);

    // Lặp lại vẫn sạch (đối soát không để lại dấu vết làm lần sau lệch).
    await expect(assertSystemInvariants(s)).resolves.toBeUndefined();
  });

  it('derives the reconciliation days from the data (not the clock) and adds explicit days', async () => {
    const s = sys();
    const tenants = [
      { name: 'acme', schema: 't_acme' },
      { name: 'beta', schema: 't_beta' },
    ];
    const nowDay = today();
    const dayBefore = (day: string) =>
      new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const days = await reconcileDaysOf(s, tenants, ['2020-01-05']);
    expect(days).toContain('2020-01-05');
    expect(days).toContain('2020-01-04');
    expect(days.some((d) => d >= dayBefore(nowDay))).toBe(true);
    expect([...days].sort()).toEqual(days);
    expect(days.every((d) => d <= nowDay)).toBe(true);

    // Một charge hoàn tất vào một ngày khác (do dữ liệu, không do đồng hồ) làm xuất hiện đúng ngày đó và ngày liền trước.
    const chargeId = (
      await sql<{ id: string }>`select top 1 id from charges order by created_at`.execute(
        s.paymentAdmin,
      )
    ).rows[0]?.id as string;
    const original = (
      await sql<{
        completed_at: Date;
      }>`select completed_at from charges where id = ${chargeId}`.execute(s.paymentAdmin)
    ).rows[0]?.completed_at as Date;
    await run(
      s.paymentAdmin,
      sql`update charges set completed_at = '2021-03-10T23:59:59.000' where id = ${chargeId}`,
    );
    try {
      const shifted = await reconcileDaysOf(s, tenants, []);
      expect(shifted).toContain('2021-03-10');
      expect(shifted).toContain('2021-03-09');
    } finally {
      await run(
        s.paymentAdmin,
        sql`update charges set completed_at = ${original} where id = ${chargeId}`,
      );
    }
    await assertSystemInvariants(s);
  });

  it('does not run reconciliation while a strict invariant already fails (autofix must not mask evidence)', async () => {
    const s = sys();
    const account = seeded().topups[0]?.accountId as string;
    const spy = spyRunner();
    await run(
      s.walletAdmin,
      sql`update t_acme.accounts set balance = balance + 1 where id = ${account}`,
    );
    try {
      const violations = await runInvariants(s, { reconcileRunner: spy.runner });
      expect(invariantsOf(violations)).toEqual(['INV-1']);
      expect(violations.every((v) => v.detail?.phase === undefined)).toBe(true);
      expect(spy.calls).toEqual([]);
    } finally {
      await run(
        s.walletAdmin,
        sql`update t_acme.accounts set balance = balance - 1 where id = ${account}`,
      );
    }
    await assertSystemInvariants(s);
  });

  it('treats a charge with no topup as a real INV-3 failure even with expectMissingAtWallet (never explained, never reconciled)', async () => {
    const s = sys();
    const spy = spyRunner();
    await run(
      s.paymentAdmin,
      sql`insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at, completed_at, metadata)
          values ('ch_chaos_nowhere', 'chaos-nowhere', 4000, 'VND', 'SUCCEEDED', '{}', ${now}, ${now}, ${now}, '{"tenantId":"acme"}')`,
    );
    try {
      for (const expectMissingAtWallet of [false, true]) {
        const violations = await runInvariants(s, {
          expectMissingAtWallet,
          reconcileRunner: spy.runner,
        });
        expect(invariantsOf(violations)).toEqual(['INV-3']);
        expect(codesOf(violations)).toContain('CHARGE_WITHOUT_TOPUP');
        expect(violations.some(isMissingAtWallet)).toBe(false);
      }
      expect(spy.calls).toEqual([]);
    } finally {
      await run(s.paymentAdmin, sql`delete from charges where id = 'ch_chaos_nowhere'`);
    }
    await assertSystemInvariants(s);
  });

  it('refuses selections that would let reconciliation hide failures, and keeps the canonical order for `only`', async () => {
    const s = sys();
    await expect(runInvariants(s, { only: ['INV-5'] })).rejects.toThrow(
      /INV-1, INV-2, INV-3, INV-4/,
    );
    await expect(runInvariants(s, { only: ['INV-5', 'INV-1', 'INV-2', 'INV-4'] })).rejects.toThrow(
      /thiếu INV-3/,
    );
    await expect(collectViolations(s, { only: ['INV-5'] })).rejects.toThrow(/INV-5/);
    await expect(runInvariants(s, { only: ['INV-9' as InvariantId] })).rejects.toThrow(/INV-9/);
    // Cờ S7 mà không có INV-5 sẽ miễn INV-3 mà không ai ghi bù: phải bị từ chối, không được lặng lẽ đạt.
    await expect(
      runInvariants(s, {
        only: ['INV-1', 'INV-2', 'INV-3', 'INV-4'],
        expectMissingAtWallet: true,
      }),
    ).rejects.toThrow(/expectMissingAtWallet/);

    // Không INV-5 thì không đối soát; thứ tự liệt kê không ảnh hưởng (luôn theo thứ tự chuẩn).
    const spy = spyRunner();
    expect(
      await runInvariants(s, { only: ['INV-8', 'INV-3', 'INV-1'], reconcileRunner: spy.runner }),
    ).toEqual([]);
    expect(spy.calls).toEqual([]);
  });
});

describe('oracle INV-5: đối soát (làm hỏng giữa lúc đối soát, có hoàn tác)', () => {
  it('reports a BALANCE_MISMATCH that is still OPEN, and the strict re-check after reconciliation agrees', async () => {
    const s = sys();
    const account = seeded().topups[0]?.accountId as string;
    let bumped = false;
    // Hỏng xuất hiện NGAY trước một lượt đối soát (mô phỏng đối soát/luồng khác làm lệch số dư).
    const spy = spyRunner(async (sys2, tenant, day, pass) => {
      if (tenant === 'acme' && pass === 1 && !bumped) {
        bumped = true;
        await run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance + 1 where id = ${account}`,
        );
      }
      return runReconciliationViaHttp(sys2, tenant, day, pass);
    });
    try {
      const violations = await runInvariants(s, { reconcileRunner: spy.runner });
      expect(invariantsOf(violations)).toEqual(['INV-1', 'INV-5']);
      expect(codesOf(violations, 'INV-5')).toContain('BALANCE_MISMATCH_OPEN');
      const after = violations.filter((v) => v.invariant === 'INV-1');
      expect(after.every((v) => v.detail?.phase === 'after-reconciliation')).toBe(true);
      expect(codesOf(after)).toEqual(expect.arrayContaining(['TOTAL_NONZERO', 'BALANCE_DRIFT']));
      // Lượt hội tụ không chạy khi lượt đầu đã có vi phạm.
      expect(spy.calls.some((c) => c.pass === 2)).toBe(false);
    } finally {
      await run(
        s.walletAdmin,
        sql`update t_acme.accounts set balance = balance - 1 where id = ${account}`,
      );
    }
    await assertSystemInvariants(s);
  });

  it('reads every page of reconciliation items (cursor), not just the first', async () => {
    const s = sys();
    const ids = ['ch_chaos_pg1', 'ch_chaos_pg2', 'ch_chaos_pg3'];
    for (const [index, id] of ids.entries()) {
      await run(
        s.paymentAdmin,
        sql`insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at, completed_at, metadata)
            values (${id}, ${`chaos-pg-ref-${index}`}, 1000, 'VND', 'SUCCEEDED', '{}', ${now}, ${now}, ${now}, '{"tenantId":"acme"}')`,
      );
    }
    try {
      // Ba charge không có topup ⇒ ba item UNKNOWN_CHARGE; cỡ trang 1 buộc phải đi qua nhiều trang.
      const paged = await reconciliationRunner(1)(s, 'acme', today(), 1);
      const unknown = paged.items.filter((i) => i.kind === 'UNKNOWN_CHARGE');
      expect(unknown.map((i) => i.chargeId).sort()).toEqual(ids);
      expect(new Set(paged.items.map((i) => i.id)).size).toBe(paged.items.length);
    } finally {
      await run(
        s.paymentAdmin,
        sql`delete from charges where id in ('ch_chaos_pg1', 'ch_chaos_pg2', 'ch_chaos_pg3')`,
      );
    }
    await assertSystemInvariants(s);
  });
  it('fails when the second reconciliation pass still finds discrepancies (convergence)', async () => {
    const s = sys();
    const spy = spyRunner(async (sys2, tenant, day, pass) => {
      const real = await runReconciliationViaHttp(sys2, tenant, day, pass);
      return pass === 2 && tenant === 'beta'
        ? { ...real, items: [fakeItem('AMOUNT_MISMATCH')] }
        : real;
    });
    const violations = await runInvariants(s, { reconcileRunner: spy.runner });
    expect(invariantsOf(violations)).toEqual(['INV-5']);
    expect(new Set(codesOf(violations))).toEqual(new Set(['RECONCILIATION_NOT_CONVERGED']));
    expect(violations.every((v) => v.detail?.tenant === 'beta')).toBe(true);
    expect(spy.calls.filter((c) => c.pass === 2).length).toBeGreaterThan(0);
  });

  it('fails the second pass when its run FAILED too, and the first pass when a run FAILED', async () => {
    const s = sys();
    const failed = (r: ReconcileRun): ReconcileRun => ({
      ...r,
      status: 'FAILED',
      failureReason: 'chaos: settlement không đọc được',
    });
    const first = await runInvariants(s, {
      reconcileRunner: spyRunner(async (sys2, tenant, day, pass) => {
        const real = await runReconciliationViaHttp(sys2, tenant, day, pass);
        return pass === 1 && tenant === 'acme' ? failed(real) : real;
      }).runner,
    });
    expect(invariantsOf(first)).toEqual(['INV-5']);
    expect(new Set(codesOf(first))).toEqual(new Set(['RECONCILIATION_RUN_FAILED']));
    expect(first[0]?.message).toContain('chaos: settlement không đọc được');

    const second = await runInvariants(s, {
      reconcileRunner: spyRunner(async (sys2, tenant, day, pass) => {
        const real = await runReconciliationViaHttp(sys2, tenant, day, pass);
        return pass === 2 && tenant === 'acme' ? failed(real) : real;
      }).runner,
    });
    expect(new Set(codesOf(second))).toEqual(new Set(['RECONCILIATION_NOT_CONVERGED']));

    // Vượt trần maxItems có mã riêng (lỗi cấu hình harness, không phải đối soát hỏng).
    const large = await runInvariants(s, {
      reconcileRunner: spyRunner(async (sys2, tenant, day, pass) => {
        const real = await runReconciliationViaHttp(sys2, tenant, day, pass);
        return pass === 1 && tenant === 'acme'
          ? { ...failed(real), failureReason: 'found 7 discrepancies, more than the limit of 5' }
          : real;
      }).runner,
    });
    expect(new Set(codesOf(large))).toEqual(new Set(['RECONCILIATION_TOO_LARGE']));
  });

  it('reports OPEN items of other kinds and an AUTO_APPLIED charge that INV-3 never flagged', async () => {
    const s = sys();
    const other = await runInvariants(s, {
      reconcileRunner: spyRunner(async (sys2, tenant, day, pass) => {
        const real = await runReconciliationViaHttp(sys2, tenant, day, pass);
        return pass === 1 && tenant === 'acme'
          ? { ...real, items: [fakeItem('UNKNOWN_CHARGE')] }
          : real;
      }).runner,
    });
    expect(invariantsOf(other)).toEqual(['INV-5']);
    expect(new Set(codesOf(other))).toEqual(new Set(['RECONCILIATION_ITEM_OPEN']));

    const unexpected = await runInvariants(s, {
      reconcileRunner: spyRunner(async (sys2, tenant, day, pass) => {
        const real = await runReconciliationViaHttp(sys2, tenant, day, pass);
        return pass === 1 && tenant === 'acme'
          ? { ...real, items: [fakeItem('MISSING_AT_WALLET', 'AUTO_APPLIED', 'RESOLVED')] }
          : real;
      }).runner,
    });
    expect(invariantsOf(unexpected)).toEqual(['INV-5']);
    expect(codesOf(unexpected)).toContain('AUTOFIX_UNEXPECTED');
  });

  it('re-checks INV-1..4 strictly AFTER reconciliation (a ledger change made by reconciliation is caught)', async () => {
    const s = sys();
    const account = seeded().topups[0]?.accountId as string;
    let bumped = false;
    // Lượt 2 được giả lập "sạch" nhưng làm lệch số dư đúng một lần: INV-5 không thấy gì, chỉ kiểm lại INV-1 sau đối soát mới bắt được.
    const spy = spyRunner(async (sys2, tenant, day, pass) => {
      if (pass === 1) return runReconciliationViaHttp(sys2, tenant, day, pass);
      if (!bumped) {
        bumped = true;
        await run(
          s.walletAdmin,
          sql`update t_acme.accounts set balance = balance + 1 where id = ${account}`,
        );
      }
      return emptyRun(tenant, day);
    });
    try {
      const violations = await runInvariants(s, { reconcileRunner: spy.runner });
      expect(invariantsOf(violations)).toEqual(['INV-1']);
      expect(violations.every((v) => v.detail?.phase === 'after-reconciliation')).toBe(true);
      expect(codesOf(violations)).toEqual(
        expect.arrayContaining(['TOTAL_NONZERO', 'BALANCE_DRIFT']),
      );
    } finally {
      await run(
        s.walletAdmin,
        sql`update t_acme.accounts set balance = balance - 1 where id = ${account}`,
      );
    }
    await assertSystemInvariants(s);
  });

  it('reports an unbalanced ledger transaction as LEDGER_UNBALANCED_OPEN (fresh system: ledger rows cannot be removed)', async () => {
    await withFreshSystem(true, async (s) => {
      let inserted = false;
      const spy = spyRunner(async (sys2, tenant, day, pass) => {
        if (tenant === 'acme' && pass === 1 && !inserted) {
          inserted = true;
          await run(
            s.walletAdmin,
            sql`insert into t_acme.ledger_transactions (id, business_key, kind, created_at) values ('chaos-ub', 'topup:chaos-ub', 'TOPUP', ${now})`,
          );
          await run(
            s.walletAdmin,
            sql`insert into t_acme.ledger_entries (transaction_id, account_id, amount, created_at) values ('chaos-ub', 'wallet:alice', 5, ${now})`,
          );
          await run(
            s.walletAdmin,
            sql`update t_acme.accounts set balance = balance + 5 where id = 'wallet:alice'`,
          );
        }
        return runReconciliationViaHttp(sys2, tenant, day, pass);
      });
      const violations = await runInvariants(s, { reconcileRunner: spy.runner });
      expect(codesOf(violations, 'INV-5')).toContain('LEDGER_UNBALANCED_OPEN');
      const after = violations.filter((v) => v.invariant === 'INV-1');
      expect(codesOf(after)).toContain('TX_UNBALANCED');
      expect(after.every((v) => v.detail?.phase === 'after-reconciliation')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// S7: webhook thành công bị mất có chủ ý → wallet thiếu khoản nạp → chỉ đối soát sửa được
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Bỏ mọi webhook payment→wallet cho tới khi payment bỏ cuộc (FAILED), trong lúc một lần nạp hoàn tất bên payment.
 * Trả topupId; topup còn PENDING ở wallet (heal chỉ chờ phần còn lại, không chờ topup).
 */
async function loseWebhook(
  s: System,
  tenant: string,
  customer: string,
  amount: number,
  key: string,
): Promise<string> {
  s.plan.enable();
  s.plan.add({
    point: 'payment-to-wallet.request',
    label: `lose-webhook-${key}`,
    action: (info) => {
      info.decision = 'drop';
    },
  });
  expect((await s.openWallet(tenant, customer)).status).toBe(201);
  const topup = await s.topup(tenant, customer, amount, key);
  expect(topup.status).toBe(202);
  await waitFor(
    async () => {
      const result = await sql<{ failed: number | null; pending: number | null }>`
        select sum(case when status = 'FAILED' then 1 else 0 end) as failed,
               sum(case when status = 'PENDING' then 1 else 0 end) as pending
        from webhook_events`.execute(s.paymentAdmin);
      return Number(result.rows[0]?.failed ?? 0) >= 1 && Number(result.rows[0]?.pending ?? 0) === 0;
    },
    { timeoutMs: 60_000, intervalMs: 200 },
  );
  await s.heal({ allowUnsettledTopups: true });
  s.plan.clear();
  return topup.topupId as string;
}

const topupState = async (s: System, tenant: string, id: string) => {
  const result = await sql<{ status: string; charge_id: string | null }>`
    select status, charge_id from ${sql.id(`t_${tenant}`, 'topups')} where id = ${id}`.execute(
    s.walletAdmin,
  );
  const tx = await sql<{ n: number }>`
    select count(*) as n from ${sql.id(`t_${tenant}`, 'ledger_transactions')}
    where business_key = concat('topup:', ${id})`.execute(s.walletAdmin);
  return { ...result.rows[0], txCount: Number(tx.rows[0]?.n ?? 0) };
};

// LƯU Ý: ba test trong describe này PHỤ THUỘC THỨ TỰ (dùng chung một hệ; test 3 ghi bù nên phải chạy sau test 1 và 2).
// Ghi chú cho kịch bản S11 (Task 10): "thử lại cùng idempotency key sau lỗi cho cùng kết quả" được kiểm TRONG kịch bản,
// không phải trong oracle (oracle chỉ nhìn trạng thái cuối).
describe('S7: mất webhook có chủ ý (expectMissingAtWallet) và đối soát ghi bù', () => {
  let lost: System | undefined;
  let lostTopupId = '';
  const sysLost = (): System => {
    if (lost === undefined) throw new Error('hệ S7 chưa dựng xong');
    return lost;
  };

  beforeAll(async () => {
    lost = await createSystem({ seed: 11, tenants: ['acme'] });
    // Một lần nạp bình thường trước, rồi một lần mất webhook: oracle phải phân biệt hai trường hợp.
    await lost.openWallet('acme', 'dave');
    expect((await lost.topup('acme', 'dave', 20_000, 'k-dave')).status).toBe(202);
    await lost.heal();
    lostTopupId = await loseWebhook(lost, 'acme', 'erin', 70_000, 'k-erin');
  });

  afterAll(async () => {
    await lost?.stop();
  });

  it('without the flag the same state fails INV-3 and reconciliation never runs (nothing is credited)', async () => {
    const s = sysLost();
    expect(await topupState(s, 'acme', lostTopupId)).toMatchObject({
      status: 'PENDING',
      txCount: 0,
    });
    const spy = spyRunner();
    const violations = await runInvariants(s, { reconcileRunner: spy.runner });
    expect(invariantsOf(violations)).toEqual(['INV-3']);
    expect(codesOf(violations)).toEqual(
      expect.arrayContaining(['CHARGE_TOPUP_NOT_SUCCEEDED', 'SUM_MISMATCH']),
    );
    expect(explainedByMissingAtWallet(violations)).toBe(true);
    expect(spy.calls).toEqual([]);
    expect(await topupState(s, 'acme', lostTopupId)).toMatchObject({
      status: 'PENDING',
      txCount: 0,
    });
    await expect(assertSystemInvariants(s)).rejects.toBeInstanceOf(InvariantViolationError);
    // collectViolations (chỉ đọc) cũng thấy cùng trạng thái, có phân loại MISSING_AT_WALLET.
    expect((await collectViolations(s)).filter(isMissingAtWallet)).toHaveLength(1);
  });

  it('fails INV-5 AUTOFIX_MISSING when reconciliation does not credit the charge INV-3 explained', async () => {
    const s = sysLost();
    // Đối soát "không thấy gì": ghi bù không xảy ra ⇒ INV-5 báo thiếu, INV-3 sau đối soát (chặt) cũng báo.
    const violations = await runInvariants(s, {
      expectMissingAtWallet: true,
      reconcileRunner: async (_sys, tenant, day) => emptyRun(tenant, day),
    });
    expect(invariantsOf(violations)).toEqual(['INV-3', 'INV-5']);
    expect(codesOf(violations, 'INV-5')).toEqual(['AUTOFIX_MISSING']);
    const inv3 = violations.filter((v) => v.invariant === 'INV-3');
    expect(inv3.every((v) => v.detail?.phase === 'after-reconciliation')).toBe(true);
    expect(await topupState(s, 'acme', lostTopupId)).toMatchObject({
      status: 'PENDING',
      txCount: 0,
    });
  });

  it('never tolerates a charge whose webhook is DELIVERED: the wallet received it but did not credit', async () => {
    const s = sysLost();
    const charge = await sql<{ id: string }>`
      select id from charges where reference = ${lostTopupId}`.execute(s.paymentAdmin);
    const chargeId = charge.rows[0]?.id as string;
    await sql`
      update webhook_events set status = 'DELIVERED', delivered_at = sysutcdatetime()
      where charge_id = ${chargeId}`.execute(s.paymentAdmin);
    try {
      const spy = spyRunner();
      const violations = await runInvariants(s, {
        expectMissingAtWallet: true,
        reconcileRunner: spy.runner,
      });
      expect(codesOf(violations, 'INV-3')).toContain('MISSING_AT_WALLET_WEBHOOK_DELIVERED');
      expect(
        violations.find((v) => v.code === 'MISSING_AT_WALLET_WEBHOOK_DELIVERED')?.detail,
      ).toEqual({ chargeIds: [chargeId] });
      expect(spy.calls).toEqual([]); // không đối soát, không che lỗi
      expect(await topupState(s, 'acme', lostTopupId)).toMatchObject({
        status: 'PENDING',
        txCount: 0,
      });
    } finally {
      await sql`
        update webhook_events set status = 'FAILED', delivered_at = null
        where charge_id = ${chargeId}`.execute(s.paymentAdmin);
    }
  });

  it('reads the wallet side in one SNAPSHOT: a topup completing between two reads is invisible to both', async () => {
    const s = sysLost();
    const read = (db: Kysely<unknown>) =>
      sql<{ failure_code: string | null }>`
        select failure_code from t_acme.topups where id = ${lostTopupId}`.execute(db);
    const seen = await readWalletSnapshot(s, async (db) => {
      const first = (await read(db)).rows[0]?.failure_code ?? null;
      // Một writer khác commit GIỮA hai lần đọc (mô phỏng webhook hoàn tất lần nạp): snapshot không được thấy.
      await sql`update t_acme.topups set failure_code = 'SNAPSHOT_PROBE' where id = ${lostTopupId}`.execute(
        s.walletAdmin,
      );
      const second = (await read(db)).rows[0]?.failure_code ?? null;
      return { first, second };
    });
    try {
      expect(seen).toEqual({ first: null, second: null });
      // Ngoài snapshot thì thấy ngay: đúng là writer đã commit.
      expect((await read(s.walletAdmin)).rows[0]?.failure_code).toBe('SNAPSHOT_PROBE');
    } finally {
      await sql`update t_acme.topups set failure_code = null where id = ${lostTopupId}`.execute(
        s.walletAdmin,
      );
    }
  });

  it('with the flag passes and reconciliation credits the lost topup exactly once (and again is a no-op)', async () => {
    const s = sysLost();
    const spy = spyRunner();
    await expect(
      assertSystemInvariants(s, { expectMissingAtWallet: true, reconcileRunner: spy.runner }),
    ).resolves.toBeUndefined();

    const applied = spy.runs
      .flatMap((r) => r.items)
      .filter((i) => i.kind === 'MISSING_AT_WALLET' && i.action === 'AUTO_APPLIED');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ topupId: lostTopupId, caseStatus: 'RESOLVED' });
    expect(await topupState(s, 'acme', lostTopupId)).toMatchObject({
      status: 'SUCCEEDED',
      txCount: 1,
    });
    const balance = await sql<{ balance: string }>`
      select balance from t_acme.accounts where id = 'wallet:erin'`.execute(s.walletAdmin);
    expect(Number(balance.rows[0]?.balance)).toBe(70_000);

    // Chạy lại (cờ vẫn bật): INV-3 giờ sạch, đối soát không ghi bù thêm, số dư không đổi.
    const again = spyRunner();
    await assertSystemInvariants(s, { expectMissingAtWallet: true, reconcileRunner: again.runner });
    expect(again.runs.flatMap((r) => r.items)).toEqual([]);
    expect(await topupState(s, 'acme', lostTopupId)).toMatchObject({ txCount: 1 });
    const balanceAfter = await sql<{ balance: string }>`
      select balance from t_acme.accounts where id = 'wallet:erin'`.execute(s.walletAdmin);
    expect(Number(balanceAfter.rows[0]?.balance)).toBe(70_000);
    await assertSystemInvariants(s);
  });
});

describe('S7 với autofix TẮT (reconciliation: { autofix: false })', () => {
  it('reports INV-5 MISSING_AT_WALLET_UNFIXED and credits nothing; INV-3 stays strict afterwards', async () => {
    const s = await createSystem({
      seed: 12,
      tenants: ['acme'],
      reconciliation: { autofix: false },
    });
    try {
      const topupId = await loseWebhook(s, 'acme', 'frank', 55_000, 'k-frank');
      const spy = spyRunner();
      const violations = await runInvariants(s, {
        expectMissingAtWallet: true,
        reconcileRunner: spy.runner,
      });
      expect(invariantsOf(violations)).toEqual(['INV-3', 'INV-5']);
      expect(codesOf(violations, 'INV-5')).toEqual(['MISSING_AT_WALLET_UNFIXED']);
      expect(violations.find((v) => v.invariant === 'INV-5')?.detail).toMatchObject({
        tenant: 'acme',
        topupId,
        action: 'NONE',
        caseStatus: 'OPEN',
      });
      const inv3 = violations.filter((v) => v.invariant === 'INV-3');
      expect(inv3.every((v) => v.detail?.phase === 'after-reconciliation')).toBe(true);
      expect(await topupState(s, 'acme', topupId)).toMatchObject({ status: 'PENDING', txCount: 0 });
      // Lượt hội tụ không chạy khi lượt đầu còn vi phạm.
      expect(spy.calls.some((c) => c.pass === 2)).toBe(false);
    } finally {
      await s.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// INV-6: thao tác vận hành
// ---------------------------------------------------------------------------------------------------------------------

const insertOps = (
  s: System,
  id: string,
  action: string,
  target: string,
  key: string,
  result = '{}',
) =>
  run(
    s.walletAdmin,
    sql`insert into t_acme.ops_actions (id, action, actor, reason, target, idempotency_key, fingerprint, result, created_at)
        values (${id}, ${action}, 'chaos', 'chaos', ${target}, ${key}, 'fp', ${result}, ${now})`,
  );

/** ops_actions là append-only (trigger): chỉ để HOÀN TÁC dòng do chính test chèn, tắt trigger rồi bật lại ngay. */
async function removeOps(s: System, ids: string[]): Promise<void> {
  await sql`disable trigger t_acme.trg_ops_actions_append_only on t_acme.ops_actions`.execute(
    s.walletAdmin,
  );
  try {
    await sql`delete from t_acme.ops_actions where id in (${sql.join(ids)})`.execute(s.walletAdmin);
  } finally {
    await sql`enable trigger t_acme.trg_ops_actions_append_only on t_acme.ops_actions`.execute(
      s.walletAdmin,
    );
  }
}

describe('oracle INV-6: ops nguyên tử (làm hỏng có hoàn tác)', () => {
  beforeAll(async () => {
    const s = sys();
    // carol (beta) đóng băng; bob (acme) đóng rồi mở băng: hai hướng của thao tác cuối.
    const body = (idempotencyKey: string) => ({ reason: 'chaos oracle seed', idempotencyKey });
    expect(
      (await s.ops('beta', '/ops/wallets/carol/freeze', body('inv6-freeze-carol'))).status,
    ).toBe(200);
    expect((await s.ops('acme', '/ops/wallets/bob/freeze', body('inv6-freeze-bob'))).status).toBe(
      200,
    );
    expect(
      (await s.ops('acme', '/ops/wallets/bob/unfreeze', body('inv6-unfreeze-bob'))).status,
    ).toBe(200);
    await s.heal();
  });

  it('is clean on real FREEZE, UNFREEZE, ADJUST, REVERSE and REPLAY_PAID actions', async () => {
    const s = sys();
    const kinds = await sql<{ action: string }>`
      select distinct action from t_acme.ops_actions`.execute(s.walletAdmin);
    expect(kinds.rows.map((r) => r.action).sort()).toEqual(
      ['ADJUST', 'REPLAY_PAID', 'REVERSE', 'UNFREEZE', 'FREEZE'].sort(),
    );
    expect(await collectViolations(s, { only: ['INV-6'] })).toEqual([]);
  });

  const frozenAt = async (s: System, schema: string, account: string): Promise<Date | null> =>
    (
      await sql<{ frozen_at: Date | null }>`
        select frozen_at from ${sql.id(schema, 'accounts')} where id = ${account}`.execute(
        s.walletAdmin,
      )
    ).rows[0]?.frozen_at ?? null;

  it('detects frozen_at that disagrees with the last FREEZE/UNFREEZE (both directions, and a wallet never frozen by ops)', async () => {
    const s = sys();
    const carolAt = await frozenAt(s, 't_beta', 'wallet:carol');
    expect(carolAt).not.toBeNull();
    // FREEZE là thao tác cuối nhưng ví không còn đóng băng.
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_beta.accounts set frozen_at = null where id = 'wallet:carol'`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_beta.accounts set frozen_at = ${carolAt} where id = 'wallet:carol'`,
        ),
      ['INV-6'],
      ['tenant beta', 'wallet:carol', 'thao tác cuối FREEZE', 'code:FREEZE_STATE_MISMATCH'],
    );
    // UNFREEZE là thao tác cuối nhưng ví lại bị đóng băng.
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.accounts set frozen_at = ${now} where id = 'wallet:bob'`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.accounts set frozen_at = null where id = 'wallet:bob'`,
        ),
      ['INV-6'],
      ['wallet:bob', 'thao tác cuối UNFREEZE', 'code:FREEZE_STATE_MISMATCH'],
    );
    // Ví chưa từng bị ops đóng băng mà có frozen_at.
    await corrupted(
      s,
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.accounts set frozen_at = ${now} where id = 'wallet:alice'`,
        ),
      () =>
        run(
          s.walletAdmin,
          sql`update t_acme.accounts set frozen_at = null where id = 'wallet:alice'`,
        ),
      ['INV-6'],
      ['wallet:alice', 'thao tác cuối không có', 'code:FREEZE_STATE_MISMATCH'],
    );
  });

  it('detects an ADJUST action with no ADJUSTMENT transaction', async () => {
    const s = sys();
    await corrupted(
      s,
      () => insertOps(s, 'chaos-op-adj', 'ADJUST', 'wallet:alice', 'chaos-key-adj'),
      () => removeOps(s, ['chaos-op-adj']),
      ['INV-6'],
      ['chaos-op-adj', 'adjustment:chaos-op-adj', 'code:ADJUST_TX_MISSING'],
    );
  });

  it('detects a REVERSE action with no matching REVERSAL, and a second REVERSE for an already reversed transaction', async () => {
    const s = sys();
    const topupTx = seeded().topups[0]?.transactionId as string;
    await corrupted(
      s,
      () => insertOps(s, 'chaos-op-rev', 'REVERSE', `transaction:${topupTx}`, 'chaos-key-rev'),
      () => removeOps(s, ['chaos-op-rev']),
      ['INV-6'],
      ['chaos-op-rev', topupTx, 'code:REVERSE_TX_MISSING'],
    );

    const reversed = (
      await sql<{ id: string }>`
        select reverses_transaction_id as id from t_acme.ledger_transactions where kind = 'REVERSAL'`.execute(
        s.walletAdmin,
      )
    ).rows[0]?.id as string;
    await corrupted(
      s,
      () => insertOps(s, 'chaos-op-rev2', 'REVERSE', `transaction:${reversed}`, 'chaos-key-rev2'),
      () => removeOps(s, ['chaos-op-rev2']),
      ['INV-6'],
      [reversed, 'code:REVERSE_ACTION_DUPLICATE'],
    );
  });

  it('detects REPLAY_PAID without its outbox row, with a wrong row, and an ops-replay outbox row without an action', async () => {
    const s = sys();
    const row = (
      await sql<{ id: string }>`
        select id from t_acme.outbox where correlation_id like 'ops-replay:%'`.execute(
        s.walletAdmin,
      )
    ).rows;
    expect(row).toHaveLength(1);
    const outboxId = row[0]?.id as string;
    const replayId = (
      await sql<{
        id: string;
      }>`select id from t_acme.ops_actions where action = 'REPLAY_PAID'`.execute(s.walletAdmin)
    ).rows[0]?.id as string;
    const setCorrelation = (value: string) =>
      run(
        s.walletAdmin,
        sql`update t_acme.outbox set correlation_id = ${value} where id = ${outboxId}`,
      );
    const setType = (value: string) =>
      run(
        s.walletAdmin,
        sql`update t_acme.outbox set event_type = ${value} where id = ${outboxId}`,
      );
    // Chiều "thao tác ⇒ dòng outbox": dòng không còn thuộc thao tác.
    await corrupted(
      s,
      () => setCorrelation('chaos-x'),
      () => setCorrelation(`ops-replay:${replayId}`),
      ['INV-6'],
      [replayId, 'code:REPLAY_OUTBOX_MISSING'],
    );
    // Retention thật có thể đã dọn dòng: cùng dữ liệu không được báo oan.
    await setCorrelation('chaos-x');
    try {
      expect(
        await collectViolations({ ...s, retentionDeletes: true }, { only: ['INV-6'] }),
      ).toEqual([]);
    } finally {
      await setCorrelation(`ops-replay:${replayId}`);
    }
    // Dòng của thao tác có nhưng sai loại sự kiện.
    await corrupted(
      s,
      () => setType('ChaosHidden'),
      () => setType('OrderPaidV1'),
      ['INV-6'],
      [replayId, 'code:REPLAY_OUTBOX_MISMATCH'],
    );
    // Chiều ngược lại: dòng outbox ops-replay không có thao tác REPLAY_PAID (kể cả khi retention thật bật).
    const insertOrphan = () =>
      run(
        s.walletAdmin,
        sql`insert into t_acme.outbox (id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at, sent_at)
            values ('chaos-replay-orphan', 'ChaosX', 'x', '{}', 'ops-replay:chaos-ghost', 'SENT', 1, ${now}, ${now}, ${now})`,
      );
    const removeOrphan = () =>
      run(s.walletAdmin, sql`delete from t_acme.outbox where id = 'chaos-replay-orphan'`);
    await corrupted(
      s,
      insertOrphan,
      removeOrphan,
      ['INV-6'],
      ['chaos-replay-orphan', 'code:REPLAY_OUTBOX_ORPHAN'],
    );
    await insertOrphan();
    try {
      expect(
        codesOf(await collectViolations({ ...s, retentionDeletes: true }, { only: ['INV-6'] })),
      ).toEqual(['REPLAY_OUTBOX_ORPHAN']);
    } finally {
      await removeOrphan();
    }
  });
});

describe('oracle INV-6 với dòng sổ cái chèn thêm (hệ riêng, không hoàn tác được)', () => {
  const insertTx = (
    s: System,
    id: string,
    key: string,
    kind: string,
    reverses: string | null = null,
  ) =>
    run(
      s.walletAdmin,
      sql`insert into t_acme.ledger_transactions (id, business_key, kind, reverses_transaction_id, created_at)
          values (${id}, ${key}, ${kind}, ${reverses}, ${now})`,
    );
  /** Cặp dòng cân bằng: cộng `wallet` và trừ tài khoản ADJUSTMENT, số dư cập nhật khớp ⇒ INV-1 không bị báo. */
  const balanced = async (s: System, tx: string, wallet: string, amount: number) => {
    await run(
      s.walletAdmin,
      sql`insert into t_acme.ledger_entries (transaction_id, account_id, amount, created_at) values (${tx}, ${wallet}, ${amount}, ${now})`,
    );
    await run(
      s.walletAdmin,
      sql`insert into t_acme.ledger_entries (transaction_id, account_id, amount, created_at) values (${tx}, 'system:ADJUSTMENT:VND', ${-amount}, ${now})`,
    );
    await run(
      s.walletAdmin,
      sql`update t_acme.accounts set balance = balance + ${amount} where id = ${wallet}`,
    );
    await run(
      s.walletAdmin,
      sql`update t_acme.accounts set balance = balance - ${amount} where id = 'system:ADJUSTMENT:VND'`,
    );
  };

  it('detects ADJUSTMENT and REVERSAL transactions without any ops_actions row', async () => {
    await withFreshSystem(true, async (s, d) => {
      await insertTx(s, 'chaos-orph-adj', 'adjustment:chaos-orph-adj', 'ADJUSTMENT');
      await balanced(s, 'chaos-orph-adj', 'wallet:alice', 100);
      const topupTx = d.topups[0]?.transactionId as string;
      await insertTx(s, 'chaos-orph-rev', 'reversal:chaos-orph', 'REVERSAL', topupTx);
      await balanced(s, 'chaos-orph-rev', 'wallet:alice', 200);
      await expectViolations(
        s,
        ['INV-6'],
        [
          'chaos-orph-adj',
          'chaos-orph-rev',
          topupTx,
          'code:ADJUSTMENT_TX_ORPHAN',
          'code:REVERSAL_TX_ORPHAN',
        ],
      );
    });
  });

  it('detects an ADJUST action that touched another wallet, or recorded another transaction id', async () => {
    await withFreshSystem(false, async (s) => {
      // chaos-w1: giao dịch tác động ví alice nhưng thao tác ghi mục tiêu bob.
      await insertTx(s, 'chaos-tx-w1', 'adjustment:chaos-w1', 'ADJUSTMENT');
      await balanced(s, 'chaos-tx-w1', 'wallet:alice', 100);
      await insertOps(
        s,
        'chaos-w1',
        'ADJUST',
        'wallet:bob',
        'chaos-kw1',
        '{"transactionId":"chaos-tx-w1"}',
      );
      // chaos-w2: đúng ví nhưng kết quả đã ghi trỏ giao dịch khác.
      await insertTx(s, 'chaos-tx-w2', 'adjustment:chaos-w2', 'ADJUSTMENT');
      await balanced(s, 'chaos-tx-w2', 'wallet:alice', 300);
      await insertOps(
        s,
        'chaos-w2',
        'ADJUST',
        'wallet:alice',
        'chaos-kw2',
        '{"transactionId":"bogus"}',
      );
      await expectViolations(
        s,
        ['INV-6'],
        [
          'chaos-w1',
          'wallet:bob',
          'chaos-w2',
          'bogus',
          'code:ADJUST_TX_WRONG_WALLET',
          'code:ADJUST_TX_RESULT_MISMATCH',
        ],
      );
    });
  });

  it('detects two ops_actions rows sharing an idempotency key (unique constraint dropped on purpose)', async () => {
    await withFreshSystem(true, async (s) => {
      await sql`alter table t_acme.ops_actions drop constraint uq_ops_actions_key`.execute(
        s.walletAdmin,
      );
      await insertOps(s, 'chaos-dup-1', 'REPLAY_PAID', 'order:x', 'chaos-same-key');
      await insertOps(s, 'chaos-dup-2', 'REPLAY_PAID', 'order:y', 'chaos-same-key');
      await expectViolations(
        s,
        ['INV-6'],
        ['chaos-same-key', 'chaos-dup-1', 'chaos-dup-2', 'code:OPS_DUPLICATE_KEY'],
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// INV-7: mọi thứ đã xác nhận thành công vẫn còn
// ---------------------------------------------------------------------------------------------------------------------

describe('oracle INV-7: expectations (retention không được làm mất dữ liệu đã xác nhận)', () => {
  it('has real acknowledged orders, topups and ops actions to compare against, and is clean', async () => {
    const s = sys();
    const e = s.expectations;
    expect(e.ordersPaid.size).toBe(4);
    expect(e.topupsCreated.size).toBe(4);
    expect(e.opsActions).toBeGreaterThanOrEqual(3);
    expect(e.opsActionIds.size).toBe(e.opsActions);
    expect([...e.ordersPaid].every((k) => k.includes('/'))).toBe(true);
    expect(await collectViolations(s, { only: ['INV-7'] })).toEqual([]);
  });

  const scenarios: Array<{
    name: string;
    set: 'ordersPaid' | 'topupsCreated' | 'opsActionIds';
    key: string;
    code: string;
  }> = [
    {
      name: 'order',
      set: 'ordersPaid',
      key: 'acme/chaos-ghost-order',
      code: 'ACKED_ORDER_MISSING',
    },
    {
      name: 'topup',
      set: 'topupsCreated',
      key: 'beta/chaos-ghost-topup',
      code: 'ACKED_TOPUP_MISSING',
    },
    {
      name: 'ops action',
      set: 'opsActionIds',
      key: 'acme/chaos-ghost-action',
      code: 'ACKED_OPS_ACTION_MISSING',
    },
    {
      name: 'order of an unknown tenant',
      set: 'ordersPaid',
      key: 'zzz/chaos-ghost-order',
      code: 'ACKED_ORDER_MISSING',
    },
  ];
  for (const scenario of scenarios) {
    it(`detects an acknowledged ${scenario.name} that no longer exists`, async () => {
      const s = sys();
      await corrupted(
        s,
        async () => {
          s.expectations[scenario.set].add(scenario.key);
        },
        async () => {
          s.expectations[scenario.set].delete(scenario.key);
        },
        ['INV-7'],
        [scenario.key, `code:${scenario.code}`],
      );
    });
  }

  it('detects a really deleted order_payments row that Orders had acknowledged (with its knock-on INV-2/INV-4)', async () => {
    const s = sys();
    const { orderId } = seeded().paid;
    const row = (
      await sql<{
        order_id: string;
        customer_id: string;
        wallet_transaction_id: string;
        amount: string;
        currency: string;
        paid_at: Date;
        paid_event_id: string | null;
      }>`select * from t_acme.order_payments where order_id = ${orderId}`.execute(s.walletAdmin)
    ).rows[0];
    expect(row).toBeDefined();
    await run(s.walletAdmin, sql`delete from t_acme.order_payments where order_id = ${orderId}`);
    try {
      const violations = await collectViolations(s);
      const inv7 = violations.filter((v) => v.invariant === 'INV-7');
      expect(inv7.map((v) => v.code)).toEqual(['ACKED_ORDER_MISSING']);
      expect(inv7[0]?.message).toContain(`acme/${orderId}`);
      // Kéo theo các bất biến chặt khác (đơn mồ côi ở sổ cái, OrderPaidV1 cho đơn không còn); INV-1/INV-3 không bị báo oan.
      expect(invariantsOf(violations)).toEqual(['INV-2', 'INV-4', 'INV-7']);
    } finally {
      await run(
        s.walletAdmin,
        sql`insert into t_acme.order_payments (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at, paid_event_id)
            values (${row?.order_id}, ${row?.customer_id}, ${row?.wallet_transaction_id}, ${row?.amount}, ${row?.currency}, ${row?.paid_at}, ${row?.paid_event_id})`,
      );
    }
    await assertSystemInvariants(s);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// INV-8: phục hồi — dịch vụ sống và đọc được
// ---------------------------------------------------------------------------------------------------------------------

describe('oracle INV-8: dịch vụ sống (chế độ child, dừng hẳn từng dịch vụ)', () => {
  it('is clean on a healthy child system, flags a crashed wallet or payment precisely, and recovers after heal()', async () => {
    const s = await createSystem({ mode: 'child', seed: 21, tenants: ['acme'] });
    try {
      await s.openWallet('acme', 'gina');
      expect((await s.topup('acme', 'gina', 10_000, 'k-gina')).status).toBe(202);
      await s.heal();
      expect(await runInvariants(s)).toEqual([]);

      const servicesOf = (violations: readonly Violation[]): string[] =>
        [...new Set(violations.map((v) => String(v.detail?.service)))].sort();

      await s.crashWallet();
      // Không ném, không đối soát (wallet chết): chỉ INV-8 và đúng cho wallet.
      const spy = spyRunner();
      let violations = await runInvariants(s, { reconcileRunner: spy.runner });
      expect(invariantsOf(violations)).toEqual(['INV-8']);
      expect(servicesOf(violations)).toEqual(['wallet']);
      expect(new Set(codesOf(violations))).toEqual(
        new Set(['HEALTH_FAILED', 'READ_FAILED', 'SERVICE_DOWN']),
      );
      expect(spy.calls).toEqual([]);
      await s.heal();
      expect(await runInvariants(s)).toEqual([]);

      await s.crashPayment();
      violations = await collectViolations(s, { only: ['INV-8'] });
      expect(servicesOf(violations)).toEqual(['payment']);
      expect(new Set(codesOf(violations))).toEqual(
        new Set(['HEALTH_FAILED', 'READ_FAILED', 'SERVICE_DOWN']),
      );
      await s.heal();
      expect(await collectViolations(s, { only: ['INV-8'] })).toEqual([]);
    } finally {
      await s.stop();
    }
  }, 240_000); // hai tiến trình con thật, hai lần crash + dựng lại: thời gian dao động mạnh theo tải máy

  it('treats a service that answers /health but cannot read through its pool as a READ_FAILED', async () => {
    const s = sys();
    // Pool của payment bị phá: mọi truy vấn SQL của payment ném lỗi nhưng /health (không chạm DB) vẫn 200.
    s.plan.enable();
    s.plan.add({
      point: 'sql.query.before',
      label: 'break-payment-reads',
      when: (i) => i.name === 'payment',
      action: () => {
        throw new Error('pool payment hỏng');
      },
    });
    try {
      const violations = await collectViolations(s, { only: ['INV-8'] });
      expect(violations.map((v) => `${String(v.detail?.service)}:${v.code}`)).toEqual([
        'payment:READ_FAILED',
      ]);
    } finally {
      s.plan.clear();
      s.plan.disable();
    }
    expect(await collectViolations(s, { only: ['INV-8'] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Retention thật: oracle không báo oan khi dòng outbox SENT / idempotency key đã bị dọn
// ---------------------------------------------------------------------------------------------------------------------

describe('oracle với retention thật (retentionDeletes)', () => {
  it('does not false-fail after outbox SENT rows and idempotency keys were purged, and still checks acknowledgements', async () => {
    const s = await createSystem({
      seed: 31,
      tenants: ['acme'],
      retention: {
        dryRun: false,
        intervalMinutes: 0.02,
        days: {
          wallet: { outboxSent: 0, processedMessages: 0, idempotencyKeys: 0 },
          payment: { webhook: 0, idempotencyKeys: 0 },
        },
      },
    });
    try {
      expect(s.retentionDeletes).toBe(true);
      await s.openWallet('acme', 'hana');
      expect((await s.topup('acme', 'hana', 90_000, 'k-hana')).status).toBe(202);
      await s.heal();
      await s.sendOrder({ tenant: 'acme', customer: 'hana', amount: 25_000 });
      await s.heal();

      const count = async (db: Db, table: string, where = '1 = 1'): Promise<number> =>
        Number(
          (
            await sql<{
              n: number;
            }>`select count(*) as n from ${sql.raw(table)} where ${sql.raw(where)}`.execute(db)
          ).rows[0]?.n ?? 0,
        );
      // Retention chạy nền: chờ tới khi nó thật sự dọn (điều kiện, không ngủ cố định).
      await waitFor(
        async () =>
          (await count(s.walletAdmin, 't_acme.outbox', "status = 'SENT'")) === 0 &&
          (await count(s.walletAdmin, 't_acme.idempotency_keys')) === 0 &&
          (await count(s.paymentAdmin, 'idempotency_keys')) === 0,
        { timeoutMs: 60_000, intervalMs: 300 },
      );
      expect(await count(s.walletAdmin, 't_acme.order_payments')).toBe(1);
      // Inbox cũng bị dọn: heal() sau đó không được treo vì dòng processed_messages đã mất, và không được đua với retention
      // (đơn mới có thể bị dọn trước khi heal kịp thấy; bằng chứng còn lại là order_payments + kết quả đã tới Orders giả).
      await waitFor(async () => (await count(s.walletAdmin, 't_acme.processed_messages')) === 0, {
        timeoutMs: 60_000,
        intervalMs: 300,
      });
      await s.heal({ timeoutMs: 20_000 });
      await s.sendOrder({ tenant: 'acme', customer: 'hana', amount: 5_000 });
      await s.heal({ timeoutMs: 30_000 });
      expect(s.expectations.ordersPaid.size).toBe(2);

      expect(await runInvariants(s)).toEqual([]);
      // Cùng dữ liệu nhưng nếu oracle tin retention không xóa: dòng OrderPaidV1 đã mất bị báo (kiểm tra có điều kiện thật sự có tác dụng).
      expect(
        codesOf(await collectViolations({ ...s, retentionDeletes: false }, { only: ['INV-4'] })),
      ).toEqual(['PAID_WITHOUT_OUTBOX']);
      // Nhưng thứ client đã được xác nhận thì retention không được đụng tới.
      expect(s.expectations.topupsCreated.size).toBe(1);
      expect(await collectViolations(s, { only: ['INV-7'] })).toEqual([]);
    } finally {
      await s.stop();
    }
  });
});
