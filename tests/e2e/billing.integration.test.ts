import { createDatabase, migrate } from '@billing/database';
import {
  createTestBroker,
  createTestDatabase,
  getFreePort,
  waitFor,
  type TestBroker,
  type TestDatabase,
} from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentMigrations } from '../../db/payment/migrations.js';
import {
  startService as startPayment,
  type RunningService as RunningPayment,
} from '../../services/payment/src/bootstrap.js';
import {
  startService as startWallet,
  type RunningService as RunningWallet,
} from '../../services/wallet/src/bootstrap.js';
import { TenantId } from '../../services/wallet/src/domain/tenant-id.js';
import { provisionTenants } from '../../services/wallet/src/infrastructure/kysely/provisioning.js';

const SECRET = 'whsec_cross_service';
const tenants = [TenantId.parse('acme'), TenantId.parse('beta')];

let paymentDb: TestDatabase;
let walletDb: TestDatabase;
let paymentAdmin: Kysely<unknown>;
let walletAdmin: Kysely<unknown>;
let payment: RunningPayment;
let wallet: RunningWallet;
let walletUrl: string;
let paymentUrl: string;
let broker: TestBroker;

beforeAll(async () => {
  paymentDb = await createTestDatabase('e2e_payment');
  walletDb = await createTestDatabase('e2e_wallet');
  paymentAdmin = createDatabase<unknown>(paymentDb.config);
  walletAdmin = createDatabase<unknown>(walletDb.config);
  await migrate(paymentAdmin, paymentMigrations);
  await provisionTenants(walletAdmin, tenants);

  const paymentPort = await getFreePort();
  paymentUrl = `http://127.0.0.1:${paymentPort}`;
  broker = await createTestBroker('e2e');
  wallet = await startWallet({
    port: 0,
    database: walletDb.config,
    tenants,
    payment: { baseUrl: paymentUrl, webhookSecret: SECRET, timeoutMs: 3000 },
    broker: broker.wallet,
    orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
    reconciliation: { autofix: true, atUtcHour: 23, maxAttempts: 3, maxItems: 1000 },
    topupBackoffSeconds: [1, 2, 3],
    workerIntervalMs: 50,
  });
  await wallet.app.listen(0, '127.0.0.1');
  walletUrl = await wallet.app.getUrl();

  payment = await startPayment({
    port: paymentPort,
    database: paymentDb.config,
    webhook: { url: `${walletUrl}/webhooks/payment`, secret: SECRET, backoffSeconds: [1, 2, 3] },
    workerIntervalMs: 50,
    responseTimeoutMs: 1000,
  });
  await payment.app.listen({ port: paymentPort, host: '127.0.0.1' });
});

afterAll(async () => {
  await payment?.stop();
  await wallet?.stop();
  await paymentAdmin?.destroy();
  await walletAdmin?.destroy();
  await paymentDb?.drop();
  await walletDb?.drop();
  await broker?.drop();
});

interface Reply<T> {
  status: number;
  body: T;
}

async function call<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  options: { tenant: string; customer: string; key?: string; body?: unknown },
): Promise<Reply<T>> {
  const response = await fetch(`${walletUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': options.tenant,
      'x-customer-id': options.customer,
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

const topupStatus = async (tenant: string, customer: string, topupId: string): Promise<string> =>
  (await call<{ status: string }>('GET', `/topups/${topupId}`, { tenant, customer })).body.status;

const waitForStatus = (tenant: string, customer: string, topupId: string, status: string) =>
  waitFor(async () => (await topupStatus(tenant, customer, topupId)) === status, {
    timeoutMs: 20_000,
    intervalMs: 100,
  });

async function chargeIdOf(tenant: string, topupId: string): Promise<string> {
  const result = await sql<{ charge_id: string }>`
    select charge_id from ${sql.id(`t_${tenant}`, 'topups')} where id = ${topupId}`.execute(
    walletAdmin,
  );
  const chargeId = result.rows[0]?.charge_id;
  if (!chargeId) throw new Error(`topup ${topupId} has no charge id`);
  return chargeId;
}

async function openWalletAndTopup(
  tenant: string,
  customer: string,
  amount: number,
  key = 'key-1',
): Promise<string> {
  const created = await call('POST', '/wallets', { tenant, customer, body: { currency: 'VND' } });
  expect(created.status).toBe(201);
  const topup = await call<{ topupId: string }>('POST', '/topups', {
    tenant,
    customer,
    key,
    body: { amount },
  });
  expect(topup.status).toBe(202);
  return topup.body.topupId;
}

describe('wallet and payment together', () => {
  it('tops up a wallet from request to credited balance, with payment agreeing on the charge', async () => {
    const topupId = await openWalletAndTopup('acme', 'e2e-full', 150000);
    await waitForStatus('acme', 'e2e-full', topupId, 'SUCCEEDED');

    const balance = await call<{ balance: number }>('GET', '/wallet', {
      tenant: 'acme',
      customer: 'e2e-full',
    });
    expect(balance.body.balance).toBe(150000);
    const entries = await call<{ items: Array<{ businessKey: string; amount: number }> }>(
      'GET',
      '/wallet/entries',
      { tenant: 'acme', customer: 'e2e-full' },
    );
    expect(entries.body.items).toEqual([
      expect.objectContaining({ businessKey: `topup:${topupId}`, amount: 150000 }),
    ]);

    const chargeId = await chargeIdOf('acme', topupId);
    const charge = await (await fetch(`${paymentUrl}/charges/${chargeId}`)).json();
    expect(charge).toMatchObject({
      chargeId,
      reference: topupId,
      amount: 150000,
      currency: 'VND',
      status: 'SUCCEEDED',
      metadata: { tenantId: 'acme' },
    });
  });

  it('creates exactly one topup and one charge when the same Idempotency-Key arrives five times at once', async () => {
    await call('POST', '/wallets', {
      tenant: 'acme',
      customer: 'e2e-dup',
      body: { currency: 'VND' },
    });
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        call<{ topupId: string }>('POST', '/topups', {
          tenant: 'acme',
          customer: 'e2e-dup',
          key: 'same-key',
          body: { amount: 70000 },
        }),
      ),
    );
    expect(replies.every((r) => r.status === 202)).toBe(true);
    const ids = new Set(replies.map((r) => r.body.topupId));
    expect(ids.size).toBe(1);
    const [topupId] = [...ids] as [string];

    await waitForStatus('acme', 'e2e-dup', topupId, 'SUCCEEDED');
    expect(
      (await call<{ balance: number }>('GET', '/wallet', { tenant: 'acme', customer: 'e2e-dup' }))
        .body.balance,
    ).toBe(70000);

    const charges = await sql<{
      n: number;
    }>`select count(*) as n from charges where reference = ${topupId}`.execute(paymentAdmin);
    expect(Number(charges.rows[0]?.n)).toBe(1);
  });

  it('keeps tenants apart: the same customer id in two tenants gets two independent wallets and charges', async () => {
    const [inAcme, inBeta] = await Promise.all([
      openWalletAndTopup('acme', 'e2e-shared', 40000),
      openWalletAndTopup('beta', 'e2e-shared', 90000),
    ]);
    await Promise.all([
      waitForStatus('acme', 'e2e-shared', inAcme, 'SUCCEEDED'),
      waitForStatus('beta', 'e2e-shared', inBeta, 'SUCCEEDED'),
    ]);

    const acmeBalance = await call<{ balance: number }>('GET', '/wallet', {
      tenant: 'acme',
      customer: 'e2e-shared',
    });
    const betaBalance = await call<{ balance: number }>('GET', '/wallet', {
      tenant: 'beta',
      customer: 'e2e-shared',
    });
    expect([acmeBalance.body.balance, betaBalance.body.balance]).toEqual([40000, 90000]);

    const acmeCharge = (await (
      await fetch(`${paymentUrl}/charges/${await chargeIdOf('acme', inAcme)}`)
    ).json()) as {
      metadata?: { tenantId?: string };
    };
    const betaCharge = (await (
      await fetch(`${paymentUrl}/charges/${await chargeIdOf('beta', inBeta)}`)
    ).json()) as {
      metadata?: { tenantId?: string };
    };
    expect([acmeCharge.metadata?.tenantId, betaCharge.metadata?.tenantId]).toEqual([
      'acme',
      'beta',
    ]);

    const crossTenant = await call('GET', `/topups/${inAcme}`, {
      tenant: 'beta',
      customer: 'e2e-shared',
    });
    expect(crossTenant.status).toBe(404);
  });

  it('leaves the ledger balanced and equal to what payment settled, per tenant', async () => {
    for (const { value: tenant } of tenants) {
      const schema = `t_${tenant}`;
      const total = await sql<{ total: string | null }>`
        select sum(balance) as total from ${sql.id(schema, 'accounts')}`.execute(walletAdmin);
      expect(Number(total.rows[0]?.total ?? 0), `${tenant}: sum of all balances`).toBe(0);

      const unbalanced = await sql<{ transaction_id: string }>`
        select transaction_id from ${sql.id(schema, 'ledger_entries')}
        group by transaction_id having sum(amount) <> 0`.execute(walletAdmin);
      expect(unbalanced.rows, `${tenant}: unbalanced transactions`).toEqual([]);

      const walletTotal = await sql<{ total: string | null }>`
        select sum(balance) as total from ${sql.id(schema, 'accounts')} where kind = 'WALLET'`.execute(
        walletAdmin,
      );
      const succeeded = await sql<{ charge_id: string }>`
        select charge_id from ${sql.id(schema, 'topups')} where status = 'SUCCEEDED'`.execute(
        walletAdmin,
      );
      const chargeIds = succeeded.rows.map((row) => row.charge_id);
      const settled =
        chargeIds.length === 0
          ? { rows: [{ total: '0' }] }
          : await sql<{ total: string | null }>`
              select sum(amount) as total from charges
              where status = 'SUCCEEDED' and id in (${sql.join(chargeIds)})`.execute(paymentAdmin);
      expect(
        Number(walletTotal.rows[0]?.total ?? 0),
        `${tenant}: wallets vs payment settlement`,
      ).toBe(Number(settled.rows[0]?.total ?? 0));
    }
  });
});
