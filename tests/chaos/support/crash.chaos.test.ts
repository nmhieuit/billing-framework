import { createDatabase } from '@billing/database';
import {
  createTestBroker,
  createTestDatabase,
  getFreePort,
  waitFor,
  type TestBroker,
  type TestDatabase,
} from '@billing/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../../services/wallet/src/domain/tenant-id.js';
import { provisionTenants } from '../../../services/wallet/src/infrastructure/kysely/provisioning.js';
import { isProcessAlive, spawnChildService, type ChildService } from './crash.js';
import { retentionFor, walletConfigFor, walletEnv } from './service-config.js';
import { createSystem, type ChildSystem } from './system-harness.js';

const portAccepts = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
};

describe('spawnChildService', () => {
  let db: TestDatabase | undefined;
  let broker: TestBroker | undefined;
  const spawned: ChildService[] = [];

  beforeAll(async () => {
    db = await createTestDatabase('chaos_child');
    const admin = createDatabase<unknown>(db.config);
    try {
      await provisionTenants(admin, [TenantId.parse('acme')]);
    } finally {
      await admin.destroy();
    }
    broker = await createTestBroker('chaos_child');
  });

  afterEach(async () => {
    // Luôn giết mọi tiến trình con đã sinh, kể cả khi test thất bại giữa chừng.
    await Promise.all(spawned.splice(0).map((child) => child.kill()));
  });

  afterAll(async () => {
    await broker?.drop();
    await db?.drop();
  });

  const walletEnvForTest = (port: number) => {
    if (db === undefined || broker === undefined) throw new Error('hạ tầng test chưa dựng xong');
    return walletEnv(
      walletConfigFor({
        port,
        database: db.config,
        tenants: [TenantId.parse('acme')],
        paymentBaseUrl: 'http://127.0.0.1:9',
        broker: broker.wallet,
        workerIntervalMs: 50,
        retention: retentionFor('off').wallet,
      }),
    );
  };

  it('starts a real wallet process, becomes ready on /health, and dies at once on kill()', async () => {
    const port = await getFreePort();
    const child = await spawnChildService({ name: 'wallet', env: walletEnvForTest(port), port });
    spawned.push(child);
    await child.waitReady();
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(isProcessAlive(child.pid)).toBe(true);

    await child.kill();

    // Bị giết bằng SIGKILL: không có mã thoát bình thường.
    expect(await child.exited).toBeNull();
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(await portAccepts(port)).toBe(false);
  });

  it('reports the captured output tail when the service refuses to start (config not loosened)', async () => {
    const port = await getFreePort();
    // Env thiếu WALLET_DB_*: loadConfig từ chối chạy, waitReady phải nêu rõ lý do từ stdout/stderr của con.
    const child = await spawnChildService({ name: 'wallet', env: {}, port });
    spawned.push(child);
    await expect(child.waitReady(30_000)).rejects.toThrow(/WALLET_DB_HOST is required/);
  });
});

describe('System mode child', () => {
  let system: ChildSystem | undefined;

  const sys = (): ChildSystem => {
    if (system === undefined) throw new Error('hệ thống chưa dựng xong');
    return system;
  };

  const getJson = async <T>(path: string, customer: string): Promise<T> => {
    const response = await fetch(`${sys().walletUrl}${path}`, {
      headers: { 'x-tenant-id': 'acme', 'x-customer-id': customer },
    });
    return (await response.json()) as T;
  };
  const balanceOf = async (customer: string): Promise<number> =>
    (await getJson<{ balance: number }>('/wallet', customer)).balance;
  const topupStatus = async (customer: string, id: string): Promise<string> =>
    (await getJson<{ status: string }>(`/topups/${id}`, customer)).status;

  beforeAll(async () => {
    system = await createSystem({ mode: 'child', seed: 7, tenants: ['acme'] });
  });

  // stop() idempotent: test "stop" bên dưới tự gọi, afterAll gọi lại để chắc chắn dù test thất bại.
  afterAll(async () => {
    await system?.stop();
  });

  it('refuses afterOrderHandled because the hook cannot cross a process boundary', async () => {
    const options = { mode: 'child', afterOrderHandled: async () => {} } as never;
    await expect(createSystem(options)).rejects.toThrow(/afterOrderHandled.*child/);
  });

  it('runs the basic flow across real processes: open, top up, order, heal', async () => {
    const s = sys();
    expect((await s.openWallet('acme', 'c-flow')).status).toBe(201);
    const topup = await s.topup('acme', 'c-flow', 100_000, 'c-k1');
    expect(topup.status).toBe(202);
    await s.heal();
    expect(await balanceOf('c-flow')).toBe(100_000);
    expect(await topupStatus('c-flow', topup.topupId as string)).toBe('SUCCEEDED');

    const { orderId } = await s.sendOrder({ tenant: 'acme', customer: 'c-flow', amount: 30_000 });
    await s.heal();
    const mine = s.orders.received().filter((r) => r.payload.orderId === orderId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ eventType: 'OrderPaidV1' });
    expect(await balanceOf('c-flow')).toBe(70_000);
  });

  it('crashWallet() stops the process for good, and restartWallet() keeps all data', async () => {
    const s = sys();
    await s.openWallet('acme', 'c-wallet');
    await s.topup('acme', 'c-wallet', 40_000, 'c-k2');
    await s.heal();
    const before = s.pids().wallet as number;

    await s.crashWallet();

    expect(isProcessAlive(before)).toBe(false);
    expect(await portAccepts(Number(new URL(s.walletUrl).port))).toBe(false);
    // Không tự bật lại.
    expect(s.pids().wallet).toBeUndefined();

    await s.restartWallet();
    expect(s.pids().wallet).not.toBe(before);
    expect(await balanceOf('c-wallet')).toBe(40_000);
    // Wallet mới vẫn chạy được luồng đầy đủ.
    await s.topup('acme', 'c-wallet', 5_000, 'c-k3');
    await s.heal();
    expect(await balanceOf('c-wallet')).toBe(45_000);
  });

  it('crashPayment() with a charge in flight: topup still converges to SUCCEEDED after restart + heal', async () => {
    const s = sys();
    s.plan.clear();
    s.plan.enable();
    // Webhook không bao giờ tới wallet: charge đã tạo ở payment nhưng topup kẹt PENDING.
    s.plan.add({
      point: 'payment-to-wallet.request',
      label: 'hold-webhook',
      action: (info) => {
        info.decision = 'drop';
      },
    });
    await s.openWallet('acme', 'c-pay');
    const topup = await s.topup('acme', 'c-pay', 60_000, 'c-k4');
    await waitFor(
      async () => {
        const rows = await sql<{
          n: number;
        }>`select count(*) as n from charges`.execute(s.paymentAdmin);
        return (rows.rows[0]?.n ?? 0) > 0 && s.plan.fired('hold-webhook') >= 1;
      },
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    expect(await topupStatus('c-pay', topup.topupId as string)).not.toBe('SUCCEEDED');
    const before = s.pids().payment as number;

    await s.crashPayment();

    expect(isProcessAlive(before)).toBe(false);
    expect(await portAccepts(Number(new URL(s.paymentUrl).port))).toBe(false);
    s.plan.clear();
    await s.restartPayment();
    await s.heal();
    expect(await topupStatus('c-pay', topup.topupId as string)).toBe('SUCCEEDED');
    expect(await balanceOf('c-pay')).toBe(60_000);
  });

  it('stop() leaves no child process behind', async () => {
    const s = sys();
    const { wallet, payment } = s.pids();
    expect(isProcessAlive(wallet as number)).toBe(true);
    expect(isProcessAlive(payment as number)).toBe(true);

    await s.stop();

    expect(isProcessAlive(wallet as number)).toBe(false);
    expect(isProcessAlive(payment as number)).toBe(false);
  });
});
