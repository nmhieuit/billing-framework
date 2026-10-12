import { createDatabase } from '@billing/database';
import { waitFor } from '@billing/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSystem, type System } from './system-harness.js';

let system: System | undefined;

const sys = (): System => {
  if (system === undefined) throw new Error('hệ thống chưa dựng xong');
  return system;
};

const getJson = async <T>(path: string, tenant: string, customer: string): Promise<T> => {
  const response = await fetch(`${sys().walletUrl}${path}`, {
    headers: { 'x-tenant-id': tenant, 'x-customer-id': customer },
  });
  return (await response.json()) as T;
};

const balanceOf = async (tenant: string, customer: string): Promise<number> =>
  (await getJson<{ balance: number }>('/wallet', tenant, customer)).balance;

const topupStatus = async (tenant: string, customer: string, id: string): Promise<string> =>
  (await getJson<{ status: string }>(`/topups/${id}`, tenant, customer)).status;

const pendingOutbox = async (s: System): Promise<number> => {
  const rows = await sql<{
    n: number;
  }>`select count(*) as n from t_acme.outbox where status <> 'SENT'`.execute(s.walletAdmin);
  return rows.rows[0]?.n ?? 0;
};

beforeAll(async () => {
  system = await createSystem({ seed: 1, tenants: ['acme'] });
});

// Mỗi test tự đặt rule của mình: xoá rule và bộ đếm của test trước (trạng thái bật/tắt giữ nguyên).
beforeEach(() => {
  system?.plan.clear();
});

// stop() idempotent: gọi lại trong afterAll dù test đã tự dừng.
afterAll(async () => {
  await system?.stop();
});

describe('in-process system harness', () => {
  it('tops up a wallet end to end and converges after heal()', async () => {
    const s = sys();
    expect((await s.openWallet('acme', 'h-topup')).status).toBe(201);
    const topup = await s.topup('acme', 'h-topup', 100_000, 'k-1');
    expect(topup.status).toBe(202);
    await s.heal();
    expect(await balanceOf('acme', 'h-topup')).toBe(100_000);
    expect(await topupStatus('acme', 'h-topup', topup.topupId as string)).toBe('SUCCEEDED');
  });

  it('pays an order and the simulated Orders service receives exactly one OrderPaidV1', async () => {
    const s = sys();
    await s.openWallet('acme', 'h-order');
    await s.topup('acme', 'h-order', 100_000, 'k-o');
    await s.heal();
    const { orderId, eventId } = await s.sendOrder({
      tenant: 'acme',
      customer: 'h-order',
      amount: 30_000,
    });
    await waitFor(() => s.orders.received().some((r) => r.payload.orderId === orderId), {
      timeoutMs: 20_000,
      intervalMs: 50,
    });
    await s.heal();
    const mine = s.orders.received().filter((r) => r.payload.orderId === orderId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ eventType: 'OrderPaidV1' });
    expect(mine[0]?.messageId).toEqual(expect.any(String));
    expect(eventId).toEqual(expect.any(String));
    expect(await balanceOf('acme', 'h-order')).toBe(70_000);
  });

  it('really routes through the fault points: a dropped first webhook is redelivered', async () => {
    const s = sys();
    // heal() ở test trước đã tắt plan; bật lại để rule có hiệu lực.
    s.plan.enable();
    s.plan.add({
      point: 'payment-to-wallet.request',
      times: 1,
      label: 'drop-first-webhook',
      action: (info) => {
        info.decision = 'drop';
      },
    });
    await s.openWallet('acme', 'h-drop');
    const topup = await s.topup('acme', 'h-drop', 40_000, 'k-d');
    // heal() tắt plan ngay, nên phải chờ lỗi thực sự xảy ra trên đường chạy trước khi heal.
    await waitFor(() => s.plan.fired('drop-first-webhook') === 1, {
      timeoutMs: 20_000,
      intervalMs: 50,
    });
    await s.heal();
    expect(s.plan.fired('drop-first-webhook')).toBe(1);
    expect(s.proxies.paymentToWallet.log.some((e) => e.decision === 'drop')).toBe(true);
    // Gửi lại diễn ra sau khi heal tắt plan nên đếm bằng log của proxy: một lần rớt rồi một lần chuyển tiếp thành công.
    const decisions = s.proxies.paymentToWallet.log.map((e) => e.decision);
    expect(decisions.indexOf('drop')).toBeGreaterThanOrEqual(0);
    expect(decisions.slice(decisions.indexOf('drop') + 1)).toContain('forward');
    expect(await topupStatus('acme', 'h-drop', topup.topupId as string)).toBe('SUCCEEDED');
    expect(await balanceOf('acme', 'h-drop')).toBe(40_000);
  });

  it('lets the SQL, broker and proxy hooks see traffic from both services', async () => {
    const s = sys();
    s.plan.enable();
    await s.openWallet('acme', 'h-hooks');
    await s.topup('acme', 'h-hooks', 20_000, 'k-hk');
    const { orderId } = await s.sendOrder({ tenant: 'acme', customer: 'h-hooks', amount: 5_000 });
    // Đợi kết quả tới Orders giả: khi đó cả SQL, publish và HTTP proxy đã chạy với plan còn bật.
    await waitFor(() => s.orders.received().some((r) => r.payload.orderId === orderId), {
      timeoutMs: 20_000,
      intervalMs: 50,
    });
    await s.heal();
    expect(s.plan.hits('sql.query.before')).toBeGreaterThan(0);
    expect(s.plan.hits('broker.publish.before')).toBeGreaterThan(0);
    expect(s.plan.hits('wallet-to-payment.request')).toBeGreaterThan(0);
    expect(s.plan.hits('wallet-to-payment.response')).toBeGreaterThan(0);
  });

  it('keeps data and ports across restartWallet() and restartPayment()', async () => {
    const s = sys();
    const before = { wallet: s.walletUrl, payment: s.paymentUrl };
    const balance = await balanceOf('acme', 'h-topup');
    await s.restartWallet();
    await s.restartPayment();
    expect(s.walletUrl).toBe(before.wallet);
    expect(s.paymentUrl).toBe(before.payment);
    expect(await balanceOf('acme', 'h-topup')).toBe(balance);
    // Dịch vụ sau khi dựng lại vẫn chạy được luồng nạp tiền đầy đủ.
    await s.openWallet('acme', 'h-restart');
    await s.topup('acme', 'h-restart', 5_000, 'k-r');
    await s.heal();
    expect(await balanceOf('acme', 'h-restart')).toBe(5_000);
  });

  it('calls /ops with actor headers, and the guard rejects missing actor or role', async () => {
    const s = sys();
    const ok = await s.ops('acme', '/ops/actions');
    expect(ok.status).toBe(200);
    const headers = { 'x-tenant-id': 'acme' };
    const noActor = await fetch(`${s.walletUrl}/ops/actions`, {
      headers: { ...headers, 'x-actor-role': 'OPS' },
    });
    expect(noActor.status).toBe(401);
    const noRole = await fetch(`${s.walletUrl}/ops/actions`, {
      headers: { ...headers, 'x-actor-id': 'chaos-ops' },
    });
    expect(noRole.status).toBe(403);
  });

  it('heal() disables the plan, so a relay blocked by a rule recovers', async () => {
    const s = sys();
    s.plan.enable();
    s.plan.add({
      point: 'broker.publish.before',
      label: 'block-publish',
      action: () => {
        throw new Error('publish bị chặn');
      },
    });
    await s.openWallet('acme', 'h-heal');
    await s.topup('acme', 'h-heal', 50_000, 'k-h');
    await waitFor(async () => (await balanceOf('acme', 'h-heal')) === 50_000, {
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    await s.sendOrder({ tenant: 'acme', customer: 'h-heal', amount: 10_000 });
    await waitFor(() => s.plan.fired('block-publish') >= 1, { timeoutMs: 20_000, intervalMs: 50 });
    // Chưa heal: publish bị chặn nên outbox còn PENDING (tất định vì rule không giới hạn lần).
    expect(await pendingOutbox(s)).toBeGreaterThan(0);
    await s.heal({ timeoutMs: 30_000 });
    expect(await pendingOutbox(s)).toBe(0);
  });

  it('heal() really blocks while the system is unsettled, and returns once it settles', async () => {
    const s = sys();
    await s.openWallet('acme', 'h-block');
    const topup = await s.topup('acme', 'h-block', 10_000, 'k-b');
    const id = topup.topupId as string;
    await s.heal();
    // Kéo topup về PENDING bằng kết nối quản trị (không có gì sẽ tự sửa nó: webhook đã giao xong).
    const set = (status: string) =>
      sql`update t_acme.topups set status = ${status} where id = ${id}`.execute(s.walletAdmin);
    await set('PENDING');
    await expect(s.heal({ timeoutMs: 1_500 })).rejects.toThrow(/quiesce hết hạn.*topups acme/);
    await set('SUCCEEDED');
    await s.heal({ timeoutMs: 15_000 });
  });

  it('heal() accelerates the outbox backoff: a row due in 10 minutes is delivered within seconds', async () => {
    const s = sys();
    s.plan.enable();
    s.plan.add({
      point: 'broker.publish.before',
      label: 'fail-publish',
      action: () => {
        throw new Error('publish bị chặn');
      },
    });
    await s.openWallet('acme', 'h-nudge');
    await s.topup('acme', 'h-nudge', 30_000, 'k-n');
    await waitFor(async () => (await balanceOf('acme', 'h-nudge')) === 30_000, {
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    const { orderId } = await s.sendOrder({ tenant: 'acme', customer: 'h-nudge', amount: 1_000 });
    await waitFor(() => s.plan.fired('fail-publish') >= 1, { timeoutMs: 20_000, intervalMs: 50 });
    // Đẩy hạn gửi lại của dòng outbox ra +10 phút và xác nhận relay không ghi đè (nó không đến hạn).
    await waitFor(
      async () => {
        await sql`update t_acme.outbox set next_attempt_at = dateadd(minute, 10, sysutcdatetime())
          where status = 'PENDING'`.execute(s.walletAdmin);
        const far = await sql<{ n: number }>`select count(*) as n from t_acme.outbox
          where status = 'PENDING' and next_attempt_at > dateadd(minute, 5, sysutcdatetime())`.execute(
          s.walletAdmin,
        );
        return (far.rows[0]?.n ?? 0) > 0;
      },
      { timeoutMs: 10_000, intervalMs: 50 },
    );
    const started = Date.now();
    await s.heal({ timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(s.orders.received().filter((r) => r.payload.orderId === orderId)).toHaveLength(1);
  });

  it('settles orders that end in the DLQ: unhosted tenant and unreadable message', async () => {
    const s = sys();
    const ghost = await s.sendOrder({ tenant: 'ghost', customer: 'nobody', amount: 1_000 });
    const poison = await s.sendRaw('đây không phải JSON {');
    const started = Date.now();
    await s.heal({ timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    const dead = await s.deadLettered();
    expect(dead).toContain(ghost.eventId);
    expect(dead).toContain(poison.messageId);
  });

  it('settles an order whose retries are exhausted into the DLQ', async () => {
    const s = sys();
    s.plan.enable();
    await s.openWallet('acme', 'h-retry');
    await s.topup('acme', 'h-retry', 20_000, 'k-rt');
    await s.heal();
    s.plan.enable();
    // retryDelaysSeconds [1, 2] => 3 lần thử; phá ghi inbox của đúng 3 lần đó để handler ném lỗi.
    s.plan.add({
      point: 'sql.query.before',
      times: 3,
      label: 'break-inbox',
      when: (i) =>
        i.name === 'wallet' &&
        typeof i.sql === 'string' &&
        i.sql.startsWith('insert') &&
        i.sql.includes('processed_messages'),
      action: () => {
        throw new Error('ghi inbox bị phá');
      },
    });
    const { eventId } = await s.sendOrder({ tenant: 'acme', customer: 'h-retry', amount: 1_000 });
    // heal() tắt plan ngay nên phải chờ message vào DLQ khi lỗi còn hiệu lực.
    await waitFor(async () => (await s.deadLettered()).includes(eventId), {
      timeoutMs: 30_000,
      intervalMs: 200,
    });
    expect(s.plan.fired('break-inbox')).toBe(3);
    const started = Date.now();
    await s.heal({ timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await balanceOf('acme', 'h-retry')).toBe(20_000);
  });

  it('sees payment SQL traffic through the payment dialect wrapper', async () => {
    const s = sys();
    s.plan.enable();
    let seen = 0;
    s.plan.add({
      point: 'sql.query.before',
      when: (i) => i.name === 'payment',
      action: () => {
        seen += 1;
      },
    });
    await s.openWallet('acme', 'h-pay');
    await s.topup('acme', 'h-pay', 7_000, 'k-p');
    await waitFor(async () => (await balanceOf('acme', 'h-pay')) === 7_000, {
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    expect(seen).toBeGreaterThan(0);
    await s.heal();
  });

  it('dropWalletBrokerConnections() leaves the Orders simulator connected', async () => {
    const s = sys();
    await s.openWallet('acme', 'h-conn');
    await s.topup('acme', 'h-conn', 9_000, 'k-c');
    await s.heal();
    expect(await s.dropWalletBrokerConnections()).toBeGreaterThan(0);
    const { orderId } = await s.sendOrder({ tenant: 'acme', customer: 'h-conn', amount: 1_000 });
    await waitFor(() => s.orders.received().some((r) => r.payload.orderId === orderId), {
      timeoutMs: 30_000,
      intervalMs: 100,
    });
    await s.heal();
    expect(await balanceOf('acme', 'h-conn')).toBe(8_000);
  });

  it('heal({ allowUnsettledTopups }) returns while a topup is unsettled, but still waits for everything else', async () => {
    const s = sys();
    await s.openWallet('acme', 'h-unsettled');
    const topup = await s.topup('acme', 'h-unsettled', 12_000, 'k-us');
    const id = topup.topupId as string;
    await s.heal();
    const set = (status: string) =>
      sql`update t_acme.topups set status = ${status} where id = ${id}`.execute(s.walletAdmin);
    await set('PENDING');
    try {
      // Mặc định vẫn chờ topup (đã kiểm ở test heal() ở trên); có tùy chọn thì không chờ nó.
      const started = Date.now();
      await s.heal({ timeoutMs: 15_000, allowUnsettledTopups: true });
      expect(Date.now() - started).toBeLessThan(10_000);
      // Các điều kiện khác vẫn áp dụng: một charge PENDING chưa đến hạn thì heal vẫn phải chờ nó.
      await sql`insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at, metadata)
        values ('ch_h_unsettled', 'h-unsettled-ref', 1000, 'VND', 'PENDING', '{}',
                dateadd(hour, 1, sysutcdatetime()), sysutcdatetime(), '{"tenantId":"acme"}')`.execute(
        s.paymentAdmin,
      );
      await expect(s.heal({ timeoutMs: 1_500, allowUnsettledTopups: true })).rejects.toThrow(
        /quiesce hết hạn.*charges còn PENDING/,
      );
    } finally {
      await set('SUCCEEDED');
      await sql`delete from charges where id = 'ch_h_unsettled'`.execute(s.paymentAdmin);
    }
    await s.heal({ timeoutMs: 15_000 });
  });

  it('records only client-acknowledged successes in expectations', async () => {
    const s = sys();
    const e = s.expectations;
    expect(s.retentionDeletes).toBe(false);
    await s.openWallet('acme', 'h-exp');

    const topups = e.topupsCreated.size;
    const ok = await s.topup('acme', 'h-exp', 10_000, 'k-exp');
    expect(ok.status).toBe(202);
    expect(e.topupsCreated.has(`acme/${ok.topupId}`)).toBe(true);
    expect(e.topupsCreated.size).toBe(topups + 1);
    // Phản hồi lỗi (kết quả không xác định) không được ghi nhận; gọi lại cùng khóa trả cùng topup nên không thêm.
    const bad = await s.topup('acme', 'h-exp', -5, 'k-exp-bad');
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(e.topupsCreated.size).toBe(topups + 1);
    expect((await s.topup('acme', 'h-exp', 10_000, 'k-exp')).topupId).toBe(ok.topupId);
    expect(e.topupsCreated.size).toBe(topups + 1);
    await s.heal();

    const actions = e.opsActions;
    const adjust = {
      reason: 'expectations',
      idempotencyKey: 'exp-adjust-1',
      direction: 'CREDIT',
      amount: 100,
      currency: 'VND',
    };
    expect((await s.ops('acme', '/ops/wallets/h-exp/adjustments', adjust)).status).toBe(201);
    expect(e.opsActions).toBe(actions + 1);
    expect((await s.ops('acme', '/ops/wallets/h-exp/adjustments', adjust)).status).toBe(201);
    expect(e.opsActions).toBe(actions + 1); // phát lại cùng khóa idempotency
    const refused = await s.ops('acme', '/ops/wallets/h-nobody/adjustments', adjust);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(e.opsActions).toBe(actions + 1);
    const freeze = { reason: 'expectations', idempotencyKey: 'exp-freeze-1' };
    expect((await s.ops('acme', '/ops/wallets/h-exp/freeze', freeze)).status).toBe(200);
    expect(e.opsActions).toBe(actions + 2);
    // Đã đóng băng rồi: không đổi gì, không ghi kiểm toán (actionId null) nên không được kỳ vọng.
    expect(
      (
        await s.ops('acme', '/ops/wallets/h-exp/freeze', {
          ...freeze,
          idempotencyKey: 'exp-freeze-2',
        })
      ).status,
    ).toBe(200);
    expect(e.opsActions).toBe(actions + 2);
    expect(
      (
        await s.ops('acme', '/ops/wallets/h-exp/unfreeze', {
          ...freeze,
          idempotencyKey: 'exp-unfreeze',
        })
      ).status,
    ).toBe(200);
    expect(e.opsActions).toBe(actions + 3);
    expect(e.opsActionIds.size).toBe(e.opsActions);

    // Đơn: chỉ ghi khi Orders đã nhận OrderPaidV1, tại thời điểm heal().
    const { orderId } = await s.sendOrder({ tenant: 'acme', customer: 'h-exp', amount: 1_000 });
    const ghost = await s.sendOrder({ tenant: 'acme', customer: 'h-nobody-order', amount: 1_000 });
    expect(e.ordersPaid.has(`acme/${orderId}`)).toBe(false);
    await s.heal();
    expect(e.ordersPaid.has(`acme/${orderId}`)).toBe(true);
    expect(e.ordersPaid.has(`acme/${ghost.orderId}`)).toBe(false); // bị từ chối: OrderPaymentFailedV1, không phải đã trả
  });

  it('stop() drops databases and vhost, and is idempotent', async () => {
    const own = await createSystem({ seed: 2, tenants: ['acme'] });
    const dbName = own.walletDb.database;
    const payName = own.paymentDb.database;
    const vhost = own.broker.wallet.vhost;
    await own.stop();
    await own.stop();
    const master = createDatabase<unknown>({ ...own.walletDb, database: 'master', poolMax: 1 });
    try {
      const found = await sql<{
        name: string;
      }>`select name from sys.databases where name in (${dbName}, ${payName})`.execute(master);
      expect(found.rows).toEqual([]);
    } finally {
      await master.destroy();
    }
    await expect(fetch(`${own.walletUrl}/health`)).rejects.toThrow();
    const server = (await import('vitest')).inject('rabbitmq');
    const auth = `Basic ${Buffer.from(`${server.adminUser}:${server.adminPassword}`).toString('base64')}`;
    const res = await fetch(
      `http://${server.host}:${server.managementPort}/api/vhosts/${encodeURIComponent(vhost)}`,
      { headers: { authorization: auth } },
    );
    expect(res.status).toBe(404);
  });
});
