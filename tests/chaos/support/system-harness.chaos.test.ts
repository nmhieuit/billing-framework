import { createDatabase } from '@billing/database';
import { waitFor } from '@billing/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  system = await createSystem({ seed: 1, tenants: ['acme'] });
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

  it('heal() waits for the system: a pending outbox row keeps it from returning', async () => {
    const s = sys();
    // Chặn relay: mọi publish bị rớt; một đơn hàng sinh ra outbox PENDING.
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
    await waitFor(async () => (await balanceOf('acme', 'h-heal')) === 40_000, {
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    // Chưa heal: outbox còn PENDING nên quiesce phải hết hạn khi plan vẫn bật.
    const rows = await sql<{
      n: number;
    }>`select count(*) as n from t_acme.outbox where status = 'PENDING'`.execute(s.walletAdmin);
    expect(rows.rows[0]?.n).toBeGreaterThan(0);
    await s.heal(); // heal tắt plan => relay chạy lại => hội tụ
    const after = await sql<{
      n: number;
    }>`select count(*) as n from t_acme.outbox where status <> 'SENT'`.execute(s.walletAdmin);
    expect(after.rows[0]?.n).toBe(0);
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
