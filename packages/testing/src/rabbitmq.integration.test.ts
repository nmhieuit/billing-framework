import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  BILLING_EXCHANGES,
  BILLING_VHOST_PERMISSIONS,
  createTestBroker,
  type TestBroker,
} from './rabbitmq.js';

const brokers: TestBroker[] = [];
afterAll(async () => {
  for (const broker of brokers) await broker.drop();
});

async function management<T>(path: string): Promise<{ status: number; body: T | null }> {
  const server = inject('rabbitmq');
  const response = await fetch(`http://${server.host}:${server.managementPort}/api/${path}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${server.adminUser}:${server.adminPassword}`).toString('base64')}`,
    },
  });
  return { status: response.status, body: response.ok ? ((await response.json()) as T) : null };
}

describe('createTestBroker', () => {
  it('creates an isolated vhost with both exchanges and the two service users', async () => {
    const broker = await createTestBroker('probe');
    brokers.push(broker);
    const vhost = encodeURIComponent(broker.wallet.vhost);

    expect((await management(`vhosts/${vhost}`)).status).toBe(200);
    const exchanges =
      (
        await management<Array<{ name: string; type: string; durable: boolean }>>(
          `exchanges/${vhost}`,
        )
      ).body ?? [];
    for (const name of BILLING_EXCHANGES) {
      expect(exchanges).toContainEqual(
        expect.objectContaining({ name, type: 'topic', durable: true }),
      );
    }

    for (const [user, expected] of Object.entries(BILLING_VHOST_PERMISSIONS)) {
      const permission = await management<{ configure: string; write: string; read: string }>(
        `permissions/${vhost}/${user}`,
      );
      expect(permission.body).toMatchObject(expected);
    }
    expect(broker.wallet).toMatchObject({ user: 'billing_wallet', vhost: broker.wallet.vhost });
    expect(broker.ecommerce).toMatchObject({ user: 'ecommerce_orders' });
    expect(broker.wallet.password).not.toBe('');
  });

  it('gives every call its own vhost', async () => {
    const a = await createTestBroker('probe');
    const b = await createTestBroker('probe');
    brokers.push(a, b);
    expect(a.wallet.vhost).not.toBe(b.wallet.vhost);
  });

  it('drops its vhost', async () => {
    const broker = await createTestBroker('probe');
    const vhost = encodeURIComponent(broker.wallet.vhost);
    await broker.drop();
    expect((await management(`vhosts/${vhost}`)).status).toBe(404);
  });

  it('closeConnections() returns 0 when nothing is connected', async () => {
    const broker = await createTestBroker('probe');
    brokers.push(broker);
    expect(await broker.closeConnections({ timeoutMs: 300 })).toBe(0);
  });
});
