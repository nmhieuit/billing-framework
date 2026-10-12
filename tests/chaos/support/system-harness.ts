import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createDatabase, migrate, type DatabaseConfig } from '@billing/database';
import {
  createTestBroker,
  createTestDatabase,
  getFreePort,
  type TestBroker,
  type TestDatabase,
} from '@billing/testing';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { PaymentRetentionConfig } from '../../../services/payment/src/config.js';
import type { WalletRetentionConfig } from '../../../services/wallet/src/config.js';
import { paymentMigrations } from '../../../db/payment/migrations.js';
import {
  startService as startPayment,
  type RunningService as RunningPayment,
} from '../../../services/payment/src/bootstrap.js';
import {
  startService as startWallet,
  type RunningService as RunningWallet,
} from '../../../services/wallet/src/bootstrap.js';
import { TenantId } from '../../../services/wallet/src/domain/tenant-id.js';
import { ORDER_PAYMENTS_QUEUE } from '../../../services/wallet/src/interface/messaging/order-payments.topology.js';
import { provisionTenants } from '../../../services/wallet/src/infrastructure/kysely/provisioning.js';
import {
  OrdersSimulator,
  peekQueue,
  queueDepth,
} from '../../../services/wallet/src/test-support-orders.js';
import { dropBrokerConnections, faultyPublisher } from './broker-faults.js';
import { FaultPlan } from './fault-plan.js';
import { HttpFaultProxy } from './http-fault-proxy.js';
import { OpLog } from './op-log.js';
import { createPrng, resolveSeed } from './prng.js';
import { quiesce, type QuiesceCondition } from './quiesce.js';
import { faultyDialect } from './sql-faults.js';

const SECRET = 'whsec_chaos';
const BACKOFF_SECONDS = [1, 2, 3];
const HEAL_TIMEOUT_MS = 90_000;

/** Cấu hình dọn dữ liệu cũ cho kịch bản retention; mặc định 'off' (worker retention không chạy). */
export type RetentionOption =
  | 'off'
  | {
      dryRun: boolean;
      batchSize?: number;
      /** Chu kỳ chạy (phút); cho phép số lẻ để kịch bản không phải chờ cả giờ. */
      intervalMinutes?: number;
      days?: {
        wallet?: Partial<{
          outboxSent: number;
          processedMessages: number;
          idempotencyKeys: number;
          reconciliation: number;
        }>;
        payment?: Partial<{ webhook: number; idempotencyKeys: number }>;
      };
    };

export interface SystemOptions {
  mode?: 'inproc'; // mode 'child' thêm ở Task 6
  seed?: number;
  tenants?: string[];
  workerIntervalMs?: number;
  retention?: RetentionOption;
  /** Móc của wallet chạy sau khi PayOrder commit, trước khi ack (mô phỏng consumer chết giữa chừng). */
  afterOrderHandled?: () => Promise<void>;
}

export interface System {
  readonly mode: 'inproc' | 'child';
  readonly seed: number;
  /** Plan duy nhất; rule phân biệt dịch vụ bằng info.name ('wallet' | 'payment' | 'wallet-to-payment' | 'payment-to-wallet'). */
  readonly plan: FaultPlan;
  readonly log: OpLog;
  readonly walletUrl: string;
  readonly paymentUrl: string;
  readonly walletDb: DatabaseConfig;
  readonly paymentDb: DatabaseConfig;
  /** Kết nối quản trị riêng, KHÔNG bị plan can thiệp. */
  /** Lưu ý: killSessions(walletDb) cũng giết các session trong pool của walletAdmin; dùng adminQuery() để thử lại một lần. */
  readonly walletAdmin: Kysely<unknown>;
  readonly paymentAdmin: Kysely<unknown>;
  readonly broker: TestBroker;
  readonly orders: OrdersSimulator;
  readonly proxies: { walletToPayment: HttpFaultProxy; paymentToWallet: HttpFaultProxy };
  openWallet(tenant: string, customer: string, currency?: string): Promise<{ status: number }>;
  topup(
    tenant: string,
    customer: string,
    amount: number,
    key: string,
  ): Promise<{ status: number; topupId?: string }>;
  sendOrder(input: {
    tenant: string;
    customer: string;
    orderId?: string;
    amount: number;
    currency?: string;
    eventId?: string;
    correlationId?: string;
  }): Promise<{ orderId: string; eventId: string }>;
  /** Gửi message thô (có thể hỏng) vào orders.events; heal() chỉ chờ nó vào DLQ vì không tenant nào xử lý được. */
  sendRaw(body: string, messageId?: string): Promise<{ messageId: string }>;
  /** messageId (= eventId) của các message đang nằm trong DLQ của wallet order-payments. */
  deadLettered(): Promise<string[]>;
  /** Đóng kết nối AMQP của user billing_wallet (không đụng kết nối của Orders giả); trả số kết nối đã đóng. */
  dropWalletBrokerConnections(): Promise<number>;
  /** Gọi /ops/...: GET khi không có body, POST khi có; luôn kèm x-actor-id (mặc định 'chaos-ops') và x-actor-role: OPS. */
  ops(
    tenant: string,
    route: string,
    body?: unknown,
    actor?: string,
  ): Promise<{ status: number; body: unknown }>;
  restartWallet(): Promise<void>;
  restartPayment(): Promise<void>;
  /**
   * Tắt plan, dựng lại dịch vụ đã dừng rồi chờ hội tụ: outbox không còn PENDING, queue (trừ DLQ) rỗng,
   * webhook_events/charges không còn PENDING, topups ở trạng thái cuối, mọi đơn đã gửi đã được xử lý hoặc nằm trong DLQ,
   * và mọi kết quả OrderPaid/OrderPaymentFailed đã SENT đều đã tới Orders giả. heal() cũng đẩy nhanh backoff của outbox.
   * Plan giữ trạng thái tắt sau heal (gọi plan.enable() nếu muốn tiêm lỗi tiếp).
   */
  heal(options?: { timeoutMs?: number }): Promise<void>;
  /** Idempotent; luôn cố dọn hết rồi mới ném lỗi gộp (nếu có). */
  stop(): Promise<void>;
}

function retentionFor(option: RetentionOption): {
  wallet: WalletRetentionConfig;
  payment: PaymentRetentionConfig;
} {
  const wallet: WalletRetentionConfig = {
    enabled: false,
    dryRun: true,
    intervalMinutes: 60,
    maxSecondsPerRun: 60,
    batchSize: 1000,
    days: { outboxSent: 14, processedMessages: 30, idempotencyKeys: 90, reconciliation: 365 },
  };
  const payment: PaymentRetentionConfig = {
    enabled: false,
    dryRun: true,
    intervalMinutes: 60,
    maxSecondsPerRun: 60,
    batchSize: 1000,
    days: { webhook: 30, idempotencyKeys: 90 },
  };
  if (option === 'off') return { wallet, payment };
  const shared = {
    enabled: true,
    dryRun: option.dryRun,
    ...(option.batchSize === undefined ? {} : { batchSize: option.batchSize }),
    ...(option.intervalMinutes === undefined ? {} : { intervalMinutes: option.intervalMinutes }),
  };
  return {
    wallet: { ...wallet, ...shared, days: { ...wallet.days, ...option.days?.wallet } },
    payment: { ...payment, ...shared, days: { ...payment.days, ...option.days?.payment } },
  };
}

/**
 * Chạy một truy vấn bằng kết nối quản trị, thử lại đúng một lần. killSessions(walletDb) giết luôn các session
 * trong pool của walletAdmin, nên truy vấn quản trị ngay sau đó có thể ném lỗi một lần; oracle nên bọc bằng hàm này.
 */
export async function adminQuery<T>(
  db: Kysely<unknown>,
  run: (db: Kysely<unknown>) => Promise<T>,
): Promise<T> {
  try {
    return await run(db);
  } catch {
    return await run(db);
  }
}

const chunks = <T>(items: readonly T[], size = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const count = async (db: Kysely<unknown>, query: RawBuilder<{ n: number }>): Promise<number> => {
  const result = await query.execute(db);
  return Number(result.rows[0]?.n ?? 0);
};

/** Dựng hệ thống wallet + payment + broker + hai proxy lỗi trong cùng tiến trình test. */
export async function createSystem(options: SystemOptions = {}): Promise<System> {
  const seed = options.seed ?? resolveSeed(process.env);
  const log = new OpLog();
  const plan = new FaultPlan({ log, prng: createPrng(seed).fork('plan') });
  const tenantNames = options.tenants ?? ['acme', 'beta'];
  const tenants = tenantNames.map((t) => TenantId.parse(t));
  const workerIntervalMs = options.workerIntervalMs ?? 50;
  const retention = retentionFor(options.retention ?? 'off');

  // Tài nguyên được gán dần; stop() dọn đúng những gì đã dựng xong (kể cả khi createSystem hỏng giữa chừng).
  let walletDbHandle: TestDatabase | undefined;
  let paymentDbHandle: TestDatabase | undefined;
  let walletAdmin: Kysely<unknown> | undefined;
  let paymentAdmin: Kysely<unknown> | undefined;
  let broker: TestBroker | undefined;
  let orders: OrdersSimulator | undefined;
  let walletToPayment: HttpFaultProxy | undefined;
  let paymentToWallet: HttpFaultProxy | undefined;
  let wallet: RunningWallet | undefined;
  let payment: RunningPayment | undefined;
  let stopPromise: Promise<void> | undefined;
  // Mọi message đơn hàng đã gửi qua sendOrder/sendRaw; tenant undefined = message thô không thuộc tenant nào.
  const sentEvents: Array<{ tenant: string | undefined; eventId: string; orderId?: string }> = [];
  const DLQ = `${ORDER_PAYMENTS_QUEUE}.dlq`;

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      const errors: unknown[] = [];
      const step = async (fn: (() => Promise<unknown>) | undefined): Promise<void> => {
        if (fn === undefined) return;
        try {
          await fn();
        } catch (error) {
          errors.push(error);
        }
      };
      await step(() => orders?.close() ?? Promise.resolve());
      await step(() => payment?.stop() ?? Promise.resolve());
      await step(() => wallet?.stop() ?? Promise.resolve());
      await step(() => walletToPayment?.stop() ?? Promise.resolve());
      await step(() => paymentToWallet?.stop() ?? Promise.resolve());
      await step(() => walletAdmin?.destroy() ?? Promise.resolve());
      await step(() => paymentAdmin?.destroy() ?? Promise.resolve());
      await step(() => walletDbHandle?.drop() ?? Promise.resolve());
      await step(() => paymentDbHandle?.drop() ?? Promise.resolve());
      await step(() => broker?.drop() ?? Promise.resolve());
      if (errors.length > 0) throw new AggregateError(errors, 'dọn hệ thống chaos có lỗi');
    })();
    return stopPromise;
  };

  try {
    walletDbHandle = await createTestDatabase('chaos_wallet');
    paymentDbHandle = await createTestDatabase('chaos_payment');
    walletAdmin = createDatabase<unknown>(walletDbHandle.config);
    paymentAdmin = createDatabase<unknown>(paymentDbHandle.config);
    await migrate(paymentAdmin, paymentMigrations);
    await provisionTenants(walletAdmin, tenants);

    broker = await createTestBroker('chaos');
    orders = await OrdersSimulator.connect(broker.ecommerce);

    // Cổng cấp trước để giữ nguyên khi restart và để proxy biết đích.
    const walletPort = await getFreePort();
    const paymentPort = await getFreePort();
    const walletUrl = `http://127.0.0.1:${walletPort}`;
    const paymentUrl = `http://127.0.0.1:${paymentPort}`;
    walletToPayment = await HttpFaultProxy.start({
      target: paymentUrl,
      plan,
      name: 'wallet-to-payment',
    });
    paymentToWallet = await HttpFaultProxy.start({
      target: walletUrl,
      plan,
      name: 'payment-to-wallet',
    });

    const walletDbConfig = walletDbHandle.config;
    const paymentDbConfig = paymentDbHandle.config;
    const brokerAccess = broker;
    const walletProxyUrl = walletToPayment.baseUrl;
    const webhookUrl = `${paymentToWallet.baseUrl}/webhooks/payment`;

    const launchWallet = async (): Promise<RunningWallet> => {
      const running = await startWallet(
        {
          port: walletPort,
          database: walletDbConfig,
          tenants,
          payment: { baseUrl: walletProxyUrl, webhookSecret: SECRET, timeoutMs: 3000 },
          broker: brokerAccess.wallet,
          orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
          reconciliation: { autofix: true, atUtcHour: 23, maxAttempts: 3, maxItems: 1000 },
          topupBackoffSeconds: BACKOFF_SECONDS,
          workerIntervalMs,
          retention: retention.wallet,
          telemetry: { sampleIntervalSeconds: 15 },
        },
        {
          wrapDialect: faultyDialect(plan, { name: 'wallet' }),
          wrapPublisher: faultyPublisher(plan),
          ...(options.afterOrderHandled === undefined
            ? {}
            : { afterOrderHandled: options.afterOrderHandled }),
        },
      );
      try {
        await running.app.listen(walletPort, '127.0.0.1');
      } catch (error) {
        await running.stop().catch(() => undefined);
        throw error;
      }
      return running;
    };

    const launchPayment = async (): Promise<RunningPayment> => {
      const running = await startPayment(
        {
          port: paymentPort,
          database: paymentDbConfig,
          webhook: { url: webhookUrl, secret: SECRET, backoffSeconds: BACKOFF_SECONDS },
          workerIntervalMs,
          responseTimeoutMs: 1000,
          retention: retention.payment,
          telemetry: { sampleIntervalSeconds: 15 },
        },
        { wrapDialect: faultyDialect(plan, { name: 'payment' }) },
      );
      try {
        await running.app.listen({ port: paymentPort, host: '127.0.0.1' });
      } catch (error) {
        await running.stop().catch(() => undefined);
        throw error;
      }
      return running;
    };

    payment = await launchPayment();
    wallet = await launchWallet();

    const adminWallet = walletAdmin;
    const adminPayment = paymentAdmin;
    const simulator = orders;
    const proxies = { walletToPayment, paymentToWallet };

    const restartWallet = async (): Promise<void> => {
      const running = wallet;
      wallet = undefined; // nếu dựng lại hỏng, heal() sẽ thấy wallet đang dừng và dựng lại
      await running?.stop();
      wallet = await launchWallet();
    };
    const restartPayment = async (): Promise<void> => {
      const running = payment;
      payment = undefined;
      await running?.stop();
      payment = await launchPayment();
    };

    const walletHeaders = (tenant: string, customer: string, key?: string) => ({
      'content-type': 'application/json',
      'x-tenant-id': tenant,
      'x-customer-id': customer,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    });

    const queueNames = async (): Promise<string[]> => {
      const server = inject('rabbitmq');
      const auth = `Basic ${Buffer.from(`${server.adminUser}:${server.adminPassword}`).toString('base64')}`;
      const response = await fetch(
        `http://${server.host}:${server.managementPort}/api/queues/${encodeURIComponent(brokerAccess.admin.vhost)}`,
        { headers: { authorization: auth } },
      );
      if (!response.ok) throw new Error(`liệt kê queue thất bại: ${response.status}`);
      return ((await response.json()) as Array<{ name: string }>).map((q) => q.name);
    };

    const deadLetteredIds = async (): Promise<string[]> =>
      (await peekQueue(brokerAccess.admin, DLQ, 10_000))
        .map((m) => m.messageId)
        .filter((id): id is string => id !== undefined);

    const conditions = (): QuiesceCondition[] => {
      const list: QuiesceCondition[] = [];
      // Backoff của relay outbox cứng trong sản phẩm (1,5,30,120,600 giây) và có thể vượt timeout của heal:
      // mỗi vòng chờ ta kéo các dòng PENDING đang chờ backoff/lease về "đến hạn" bằng kết nối quản trị
      // (không qua dialect bị tiêm lỗi). Lịch backoff tự nó đã có test riêng trong wallet.
      list.push({
        name: 'đẩy nhanh backoff của outbox',
        check: async () => {
          for (const tenant of tenantNames) {
            await sql`
              update ${sql.id(`t_${tenant}`)}.outbox set next_attempt_at = sysutcdatetime()
              where status = 'PENDING' and next_attempt_at > sysutcdatetime()`.execute(adminWallet);
          }
          return true;
        },
      });
      for (const tenant of tenantNames) {
        const schema = sql.id(`t_${tenant}`);
        list.push({
          name: `outbox ${tenant} còn PENDING`,
          check: async () =>
            (await count(
              adminWallet,
              sql<{ n: number }>`select count(*) as n from ${schema}.outbox where status <> 'SENT'`,
            )) === 0,
        });
        list.push({
          name: `topups ${tenant} chưa ở trạng thái cuối`,
          check: async () =>
            (await count(
              adminWallet,
              sql<{
                n: number;
              }>`select count(*) as n from ${schema}.topups where status in ('REQUESTED', 'PENDING')`,
            )) === 0,
        });
      }
      list.push({
        name: 'đơn đã gửi chưa được xử lý hoặc vào DLQ',
        check: async () => {
          // Một đơn coi là xong khi wallet đã ghi inbox (processed_messages) HOẶC nó nằm trong DLQ
          // (tenant không được host, message hỏng, hết lượt retry). Gom theo tenant: một truy vấn mỗi tenant.
          let unsettled = new Set(sentEvents.map((e) => e.eventId));
          for (const tenant of tenantNames) {
            const ids = sentEvents.filter((e) => e.tenant === tenant).map((e) => e.eventId);
            for (const chunk of chunks(ids)) {
              const done = await sql<{ message_id: string }>`
                select message_id from ${sql.id(`t_${tenant}`)}.processed_messages
                where message_id in (${sql.join(chunk)})`.execute(adminWallet);
              for (const row of done.rows) unsettled.delete(row.message_id);
            }
          }
          if (unsettled.size === 0) return true;
          const dead = new Set(await deadLetteredIds());
          unsettled = new Set([...unsettled].filter((id) => !dead.has(id)));
          return unsettled.size === 0;
        },
      });
      list.push({
        name: 'kết quả đơn hàng chưa tới Orders giả',
        check: async () => {
          // Outbox đã SENT nhưng simulator chưa kịp ghi nhận: tránh đua giữa giao nhận và mảng results.
          const have = new Set(simulator.received().map((r) => r.messageId));
          for (const tenant of tenantNames) {
            const orderIds = sentEvents
              .filter((e) => e.tenant === tenant && e.orderId !== undefined)
              .map((e) => e.orderId as string);
            for (const chunk of chunks(orderIds)) {
              const sent = await sql<{ id: string }>`
                select id from ${sql.id(`t_${tenant}`)}.outbox
                where status = 'SENT' and event_type in ('OrderPaidV1', 'OrderPaymentFailedV1')
                  and json_value(payload, '$.orderId') in (${sql.join(chunk)})`.execute(
                adminWallet,
              );
              if (sent.rows.some((row) => !have.has(row.id))) return false;
            }
          }
          return true;
        },
      });
      list.push({
        name: 'webhook_events còn PENDING',
        check: async () =>
          (await count(
            adminPayment,
            sql<{ n: number }>`select count(*) as n from webhook_events where status = 'PENDING'`,
          )) === 0,
      });
      list.push({
        name: 'charges còn PENDING',
        check: async () =>
          (await count(
            adminPayment,
            sql<{ n: number }>`select count(*) as n from charges where status = 'PENDING'`,
          )) === 0,
      });
      list.push({
        name: 'queue của vhost chưa rỗng',
        check: async () => {
          // DLQ là nơi dừng chân hợp lệ của message độc: kịch bản tự kiểm riêng, heal không chờ nó rỗng.
          for (const name of await queueNames()) {
            if (name.endsWith('.dlq')) continue;
            if ((await queueDepth(brokerAccess.admin, name)) > 0) return false;
          }
          return true;
        },
      });
      return list;
    };

    const heal = async (healOptions: { timeoutMs?: number } = {}): Promise<void> => {
      plan.disable();
      log.record('heal.start');
      if (payment === undefined) payment = await launchPayment();
      if (wallet === undefined) wallet = await launchWallet();
      await quiesce(conditions(), { timeoutMs: healOptions.timeoutMs ?? HEAL_TIMEOUT_MS });
      log.record('heal.done');
    };

    const wallets = (tenant: string, customer: string, key?: string) => ({
      url: walletUrl,
      headers: walletHeaders(tenant, customer, key),
    });

    return {
      mode: 'inproc',
      seed,
      plan,
      log,
      walletUrl,
      paymentUrl,
      walletDb: walletDbConfig,
      paymentDb: paymentDbConfig,
      walletAdmin: adminWallet,
      paymentAdmin: adminPayment,
      broker: brokerAccess,
      orders: simulator,
      proxies,
      async openWallet(tenant, customer, currency = 'VND') {
        const { url, headers } = wallets(tenant, customer);
        const response = await fetch(`${url}/wallets`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ currency }),
        });
        await response.arrayBuffer();
        log.record('openWallet', { tenant, customer, status: response.status });
        return { status: response.status };
      },
      async topup(tenant, customer, amount, key) {
        const { url, headers } = wallets(tenant, customer, key);
        const response = await fetch(`${url}/topups`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ amount }),
        });
        const body = (await response.json().catch(() => ({}))) as { topupId?: string };
        log.record('topup', { tenant, customer, amount, key, status: response.status });
        return body.topupId === undefined
          ? { status: response.status }
          : { status: response.status, topupId: body.topupId };
      },
      async sendOrder(input) {
        const event = simulator.ready({
          tenantId: input.tenant,
          customerId: input.customer,
          amount: input.amount,
          ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
          ...(input.currency === undefined ? {} : { currency: input.currency as 'VND' }),
          ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        });
        await simulator.publish(event);
        sentEvents.push({
          tenant: input.tenant,
          eventId: event.eventId,
          orderId: event.orderId,
        });
        log.record('sendOrder', { tenant: input.tenant, orderId: event.orderId });
        return { orderId: event.orderId, eventId: event.eventId };
      },
      async sendRaw(body, messageId = randomUUID()) {
        await simulator.publishRaw(body, messageId);
        sentEvents.push({ tenant: undefined, eventId: messageId });
        log.record('sendRaw', { messageId });
        return { messageId };
      },
      deadLettered: deadLetteredIds,
      dropWalletBrokerConnections: () => dropBrokerConnections(brokerAccess, 'billing_wallet'),
      async ops(tenant, route, body, actor = 'chaos-ops') {
        const response = await fetch(`${walletUrl}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tenant-id': tenant,
            'x-actor-id': actor,
            'x-actor-role': 'OPS',
            'x-request-id': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = text === '' ? undefined : JSON.parse(text);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        return { status: response.status, body: parsed };
      },
      restartWallet,
      restartPayment,
      heal,
      stop,
    };
  } catch (error) {
    // Dựng dở thì dọn phần đã dựng rồi ném lại lỗi gốc (lỗi dọn không được che lỗi gốc).
    await stop().catch(() => undefined);
    throw error;
  }
}
