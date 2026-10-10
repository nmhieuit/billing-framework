import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import './provided-context.js';

export interface BrokerAccess {
  host: string;
  port: number;
  vhost: string;
  user: string;
  password: string;
}

/** Nguyên văn bảng quyền của spec (mục 3); `deploy/scripts/init-rabbitmq.sh` phải khớp (có test kiểm tra). */
export const BILLING_VHOST_PERMISSIONS = {
  billing_wallet: {
    configure: '^wallet\\..*',
    write: '^(billing\\.events|wallet\\..*)$',
    read: '^(orders\\.events|wallet\\..*)$',
  },
  ecommerce_orders: {
    configure: '^ecommerce\\..*',
    write: '^(orders\\.events|ecommerce\\..*)$',
    read: '^(billing\\.events|ecommerce\\..*)$',
  },
} as const;

export const BILLING_EXCHANGES = ['orders.events', 'billing.events'] as const;

const TEST_PASSWORDS = {
  billing_wallet: 'wallet-test-password',
  ecommerce_orders: 'ecommerce-test-password',
} as const;

export interface TestBroker {
  wallet: BrokerAccess;
  ecommerce: BrokerAccess;
  admin: BrokerAccess;
  /** Xóa các kết nối của vhost này (của riêng `user` nếu có) để mô phỏng mất kết nối. Trả về số kết nối đã xóa. */
  closeConnections(options?: { timeoutMs?: number; user?: string }): Promise<number>;
  drop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

/** Tạo một vhost ngẫu nhiên giống môi trường thật: hai exchange topic, hai user với quyền theo spec. */
export async function createTestBroker(prefix = 'test'): Promise<TestBroker> {
  const server = inject('rabbitmq');
  const vhost = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const base = `http://${server.host}:${server.managementPort}/api`;
  const authorization = `Basic ${Buffer.from(`${server.adminUser}:${server.adminPassword}`).toString('base64')}`;

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${base}/${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(
        `RabbitMQ management ${method} ${path} -> ${response.status} ${await response.text()}`,
      );
    }
    return response;
  };

  await call('PUT', `vhosts/${enc(vhost)}`, {});
  await call('PUT', `permissions/${enc(vhost)}/${enc(server.adminUser)}`, {
    configure: '.*',
    write: '.*',
    read: '.*',
  });
  for (const [user, permissions] of Object.entries(BILLING_VHOST_PERMISSIONS)) {
    await call('PUT', `users/${user}`, {
      password: TEST_PASSWORDS[user as keyof typeof TEST_PASSWORDS],
      tags: '',
    });
    await call('PUT', `permissions/${enc(vhost)}/${user}`, permissions);
  }
  for (const name of BILLING_EXCHANGES) {
    await call('PUT', `exchanges/${enc(vhost)}/${enc(name)}`, { type: 'topic', durable: true });
  }

  const access = (user: string, password: string): BrokerAccess => ({
    host: server.host,
    port: server.amqpPort,
    vhost,
    user,
    password,
  });

  return {
    wallet: access('billing_wallet', TEST_PASSWORDS.billing_wallet),
    ecommerce: access('ecommerce_orders', TEST_PASSWORDS.ecommerce_orders),
    admin: access(server.adminUser, server.adminPassword),
    async closeConnections({ timeoutMs = 15_000, user } = {}) {
      // Management API chỉ liệt kê kết nối sau ~5 giây: thăm dò đến khi thấy.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const listed = await call('GET', `vhosts/${enc(vhost)}/connections`);
        const connections = ((await listed.json()) as Array<{ name: string; user: string }>).filter(
          (connection) => user === undefined || connection.user === user,
        );
        if (connections.length > 0) {
          for (const connection of connections)
            await call('DELETE', `connections/${enc(connection.name)}`);
          return connections.length;
        }
        if (Date.now() >= deadline) return 0;
        await sleep(500);
      }
    },
    async drop() {
      await call('DELETE', `vhosts/${enc(vhost)}`);
    },
  };
}
