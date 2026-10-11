import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from 'amqplib';

const ENV_FILE = resolve(import.meta.dirname, '../../deploy/.env');
const EXCHANGE = 'orders.events';
const ROUTING_KEY = 'order-ready-for-payment.v1';
const TOPUP_AMOUNT = 500_000;
const CUSTOMERS = ['seed-1', 'seed-2', 'seed-3'];
/** Hai đơn trong số dư và một đơn vượt số dư (bị từ chối INSUFFICIENT_FUNDS). */
const ORDER_AMOUNTS = [10_000, 20_000, 10_000_000];

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface PublishedMessage {
  routingKey: string;
  messageId: string;
  type: string;
  body: string;
}

export interface SeedDeps {
  fetchImpl: FetchImpl;
  /** Publish một message lên exchange `orders.events`. */
  publish: (message: PublishedMessage) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

export interface SeedOptions {
  walletUrl: string;
  tenants: string[];
  withDlq: boolean;
  /** Ngày đối soát (UTC, YYYY-MM-DD). */
  reconcileDate: string;
  /** Thời gian chờ tối đa cho mỗi bước thăm dò (nạp tiền, đối soát). */
  timeoutMs: number;
  pollMs: number;
}

type Json = Record<string, unknown>;

class WalletApi {
  constructor(
    private readonly base: string,
    private readonly fetchImpl: FetchImpl,
  ) {}

  async call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
    okStatuses: number[] = [200],
  ): Promise<Json> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, init);
    } catch (e) {
      throw new SeedError(`${method} ${path} failed: ${(e as Error).message}`);
    }
    if (!okStatuses.includes(res.status)) {
      const text = (await res.text().catch(() => '')).trim();
      throw new SeedError(`${method} ${path} -> HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    return (await res.json()) as Json;
  }
}

const caller = (tenant: string, customer: string): Record<string, string> => ({
  'x-tenant-id': tenant,
  'x-customer-id': customer,
});

/** Thăm dò đến khi `check` trả giá trị, hoặc ném lỗi khi quá hạn. */
async function poll<T>(
  deps: Pick<SeedDeps, 'sleep' | 'now'>,
  options: Pick<SeedOptions, 'timeoutMs' | 'pollMs'>,
  check: () => Promise<T | undefined>,
  timeoutMessage: string,
): Promise<T> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (deps.now() >= deadline) throw new SeedError(timeoutMessage);
    await deps.sleep(options.pollMs);
  }
}

export async function seed(options: SeedOptions, deps: SeedDeps): Promise<void> {
  const api = new WalletApi(options.walletUrl, deps.fetchImpl);
  const seconds = Math.round(options.timeoutMs / 1000);
  const total = options.withDlq ? 5 : 4;

  // Bước 1: tạo ví (201 hoặc 200 đều được, chạy lại an toàn).
  deps.log(
    `[1/${total}] creating wallets ${CUSTOMERS.join(', ')} for tenants ${options.tenants.join(', ')}`,
  );
  for (const tenant of options.tenants) {
    for (const customer of CUSTOMERS) {
      await api.call('POST', '/wallets', caller(tenant, customer), { currency: 'VND' }, [200, 201]);
    }
  }

  // Bước 2: nạp tiền với Idempotency-Key cố định, chờ yêu cầu nạp thành công (không dựa vào số dư vì
  // lần chạy sau số dư đã bị các đơn của lần trước trừ bớt).
  deps.log(`[2/${total}] topping up ${TOPUP_AMOUNT} VND per wallet`);
  for (const tenant of options.tenants) {
    for (const customer of CUSTOMERS) {
      const headers = {
        ...caller(tenant, customer),
        'Idempotency-Key': `seed-topup-${tenant}-${customer}`,
      };
      const created = await api.call(
        'POST',
        '/topups',
        headers,
        { amount: TOPUP_AMOUNT },
        [200, 201, 202],
      );
      const topupId = String(created.topupId);
      await poll(
        deps,
        options,
        async () => {
          const view = await api.call('GET', `/topups/${topupId}`, caller(tenant, customer));
          if (view.status === 'SUCCEEDED') return true;
          if (view.status === 'FAILED') {
            throw new SeedError(`top-up ${topupId} for ${tenant}/${customer} ended FAILED`);
          }
          return undefined;
        },
        `top-up ${topupId} for ${tenant}/${customer} did not succeed within ${seconds} s; ` +
          'check that payment is running and its webhook secret matches',
      );
    }
  }

  // Bước 3: ba đơn OrderReadyForPaymentV1 cho mỗi tenant.
  deps.log(`[3/${total}] publishing ${ORDER_AMOUNTS.length} orders per tenant to ${EXCHANGE}`);
  for (const tenant of options.tenants) {
    for (const [i, amount] of ORDER_AMOUNTS.entries()) {
      const eventId = randomUUID();
      const body = {
        eventId,
        occurredAtUtc: new Date().toISOString(),
        tenantId: tenant,
        correlationId: `seed-${eventId}`,
        orderId: randomUUID(),
        customerId: CUSTOMERS[i]!,
        amount,
        currency: 'VND',
      };
      await deps.publish({
        routingKey: ROUTING_KEY,
        messageId: eventId,
        type: 'OrderReadyForPaymentV1',
        body: JSON.stringify(body),
      });
    }
  }

  // Bước 4: đối soát ngày hôm nay theo từng tenant, chờ COMPLETED.
  deps.log(`[4/${total}] running reconciliation for ${options.reconcileDate}`);
  for (const tenant of options.tenants) {
    const headers = { 'x-tenant-id': tenant };
    const run = await api.call(
      'POST',
      '/reconciliations',
      headers,
      { date: options.reconcileDate },
      [200, 202],
    );
    const runId = String(run.runId);
    await poll(
      deps,
      options,
      async () => {
        const view = await api.call('GET', `/reconciliations/${runId}`, headers);
        if (view.status === 'COMPLETED') return true;
        if (view.status === 'FAILED') {
          throw new SeedError(`reconciliation run ${runId} for ${tenant} ended FAILED`);
        }
        return undefined;
      },
      `reconciliation run ${runId} for ${tenant} did not complete within ${seconds} s`,
    );
  }

  // Bước 5: một message không đọc được, consumer sẽ reject vào DLQ.
  if (options.withDlq) {
    deps.log(`[5/${total}] publishing one unreadable message (goes to wallet.order-payments.dlq)`);
    await deps.publish({
      routingKey: ROUTING_KEY,
      messageId: randomUUID(),
      type: 'OrderReadyForPaymentV1',
      body: JSON.stringify({ not: 'a valid event' }),
    });
  }
  deps.log('seed finished');
}

/** Đọc file dạng KEY=VALUE (bỏ dòng trống và chú thích, bỏ nháy bao quanh giá trị). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function resolveMqPassword(
  env: Record<string, string | undefined>,
  envFileText: string | undefined,
): string {
  const key = 'BILLING_ECOMMERCE_MQ_PASSWORD';
  const value = env[key] || (envFileText ? parseEnvFile(envFileText)[key] : undefined);
  if (!value) {
    throw new SeedError(
      `${key} is not set: export it or add it to deploy/.env (the password of the RabbitMQ user ecommerce_orders)`,
    );
  }
  return value;
}

export function buildAmqpUrl(host: string, port: number, password: string): string {
  return `amqp://ecommerce_orders:${encodeURIComponent(password)}@${host}:${port}/billing`;
}

async function readEnvFile(): Promise<string | undefined> {
  try {
    return await readFile(ENV_FILE, 'utf8');
  } catch {
    return undefined;
  }
}

export async function main(argv: string[]): Promise<number> {
  const unknown = argv.filter((a) => a !== '--' && a !== '--with-dlq');
  if (unknown.length > 0) {
    console.error(`Unknown option ${unknown[0]}\nUsage: local:seed [-- --with-dlq]`);
    return 2;
  }
  const envFileText = await readEnvFile();
  const fileEnv = envFileText ? parseEnvFile(envFileText) : {};
  const get = (key: string): string | undefined => process.env[key] || fileEnv[key];

  try {
    const password = resolveMqPassword(process.env, envFileText);
    const port = Number(get('LOCAL_AMQP_PORT') ?? 15673);
    const tenants = (get('LOCAL_TENANTS') ?? 'acme,beta')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');

    const connection = await connect(buildAmqpUrl('localhost', port, password));
    const channel = await connection.createConfirmChannel();
    try {
      await seed(
        {
          walletUrl: process.env.WALLET_URL ?? 'http://localhost:3001',
          tenants,
          withDlq: argv.includes('--with-dlq'),
          reconcileDate: new Date().toISOString().slice(0, 10),
          timeoutMs: 90_000,
          pollMs: 1000,
        },
        {
          fetchImpl: (input, init) => fetch(input, init),
          publish: (m) =>
            new Promise<void>((resolveP, rejectP) => {
              channel.publish(
                EXCHANGE,
                m.routingKey,
                Buffer.from(m.body, 'utf8'),
                {
                  persistent: true,
                  contentType: 'application/json',
                  messageId: m.messageId,
                  type: m.type,
                },
                (err) => (err ? rejectP(err as Error) : resolveP()),
              );
            }),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: Date.now,
          log: (m) => console.log(m),
        },
      );
    } finally {
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
    return 0;
  } catch (e) {
    if (e instanceof SeedError) {
      console.error(e.message);
      return 1;
    }
    console.error(`seed failed: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
