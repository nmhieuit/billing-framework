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
import { paymentMigrations } from '../../../db/payment/migrations.js';
import { startService as startPayment } from '../../../services/payment/src/bootstrap.js';
import { startService as startWallet } from '../../../services/wallet/src/bootstrap.js';
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
import {
  DEFAULT_RECONCILIATION,
  paymentConfigFor,
  paymentEnv,
  retentionFor,
  walletConfigFor,
  walletEnv,
  type RetentionOption,
} from './service-config.js';
import { faultyDialect } from './sql-faults.js';
import { isProcessAlive, spawnChildService, type ChildService } from './crash.js';

export type { RetentionOption } from './service-config.js';

const HEAL_TIMEOUT_MS = 90_000;

export interface SystemOptions {
  /**
   * 'inproc' (mặc định): wallet/payment chạy trong tiến trình test, có faultyDialect/faultyPublisher.
   * 'child': mỗi dịch vụ là một tiến trình Node thật (crashWallet/crashPayment = SIGKILL). Khác tiến trình nên KHÔNG có
   * faultyDialect/faultyPublisher: rule ở điểm 'sql.*' / 'broker.publish.*' không bao giờ bắn; còn proxy HTTP,
   * killSessions, dropWalletBrokerConnections và crash/restart vẫn dùng được. `afterOrderHandled` bị từ chối.
   */
  mode?: 'inproc' | 'child';
  seed?: number;
  tenants?: string[];
  workerIntervalMs?: number;
  retention?: RetentionOption;
  /**
   * Đối soát của wallet. `autofix` mặc định BẬT (như cấu hình harness từ trước); tắt để thử ca "đối soát chỉ báo, không ghi bù".
   * Chỉ đổi cấu hình dịch vụ; áp dụng cho cả hai chế độ (child nhận qua RECONCILE_AUTOFIX).
   */
  reconciliation?: { autofix?: boolean };
  /** Móc của wallet chạy sau khi PayOrder commit, trước khi ack (mô phỏng consumer chết giữa chừng). */
  afterOrderHandled?: () => Promise<void>;
}

/**
 * Những gì client ĐÃ NHẬN XÁC NHẬN THÀNH CÔNG (retention không bao giờ được làm mất chúng; oracle INV-7 đối chiếu).
 * Client nhận lỗi/không có phản hồi = kết quả không xác định nên KHÔNG ghi vào đây.
 */
export interface Expectations {
  /** `<tenant>/<orderId>` của đơn mà Orders giả đã nhận OrderPaidV1, tính tới lần heal() gần nhất (xem heal()). */
  readonly ordersPaid: Set<string>;
  /** `<tenant>/<topupId>` của lần nạp mà POST /topups đã trả 2xx kèm topupId. */
  readonly topupsCreated: Set<string>;
  /** `<tenant>/<actionId>` của thao tác ops POST đã trả 2xx kèm actionId (đã ghi ops_actions). Gọi lại cùng khóa không tăng. */
  readonly opsActionIds: Set<string>;
  /** Số thao tác ops đã được ghi nhận (= opsActionIds.size). */
  readonly opsActions: number;
}

export interface System {
  readonly mode: 'inproc' | 'child';
  readonly seed: number;
  /** Đúng khi retention ở chế độ THẬT (enabled, dryRun=false): outbox SENT / idempotency key / processed_messages có thể đã bị dọn. */
  readonly retentionDeletes: boolean;
  readonly expectations: Expectations;
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
   * `allowUnsettledTopups`: không chờ topup rời REQUESTED/PENDING (kịch bản mất webhook có chủ ý, S7: wallet sẽ không bao giờ
   * nhận kết quả, chỉ đối soát sửa được); mọi điều kiện khác (outbox, queue, webhook, charge, đơn hàng) vẫn phải hội tụ.
   * Cuối heal, các OrderPaidV1 Orders giả đã nhận được ghi vào expectations.ordersPaid.
   */
  heal(options?: { timeoutMs?: number; allowUnsettledTopups?: boolean }): Promise<void>;
  /** Idempotent; luôn cố dọn hết (kể cả giết mọi tiến trình con) rồi mới ném lỗi gộp (nếu có). */
  stop(): Promise<void>;
}

/** System ở chế độ 'child': thêm crash thật bằng SIGKILL. Không có faultyDialect/faultyPublisher (khác tiến trình). */
export interface ChildSystem extends System {
  readonly mode: 'child';
  /** SIGKILL wallet ngay, đợi tiến trình thoát; KHÔNG tự bật lại (dùng restartWallet() hoặc heal()). */
  crashWallet(): Promise<void>;
  /** SIGKILL payment ngay, đợi tiến trình thoát; KHÔNG tự bật lại (dùng restartPayment() hoặc heal()). */
  crashPayment(): Promise<void>;
  /** pid của tiến trình con đang chạy; undefined khi đang bị crash/dừng. */
  pids(): { wallet?: number; payment?: number };
}

export type ChildSystemOptions = Omit<SystemOptions, 'mode' | 'afterOrderHandled'> & {
  mode: 'child';
  /** Không dùng được ở mode 'child' (hàm trong tiến trình test không qua được ranh giới tiến trình). */
  afterOrderHandled?: never;
};

export type InprocSystemOptions = Omit<SystemOptions, 'mode'> & { mode?: 'inproc' };

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

/** Dịch vụ đang chạy: chỉ cần dừng được (inproc: RunningService; child: ChildService, có thêm pid/kill). */
type Handle = { stop(): Promise<void>; readonly pid?: number; kill?(): Promise<void> };

/**
 * Dựng hệ thống wallet + payment + broker + hai proxy lỗi. Mặc định cả hai dịch vụ chạy trong tiến trình test
 * (mode 'inproc'); mode 'child' chạy chúng thành tiến trình con thật để crash bằng SIGKILL (xem SystemOptions.mode).
 */
export async function createSystem(options: ChildSystemOptions): Promise<ChildSystem>;
export async function createSystem(options?: InprocSystemOptions): Promise<System>;
export async function createSystem(options: SystemOptions = {}): Promise<System | ChildSystem> {
  const mode = options.mode ?? 'inproc';
  if (mode === 'child' && options.afterOrderHandled !== undefined) {
    throw new Error(
      "createSystem: afterOrderHandled không dùng được với mode 'child' (móc là hàm trong tiến trình test, không đi qua ranh giới tiến trình)",
    );
  }
  const seed = options.seed ?? resolveSeed(process.env);
  const log = new OpLog();
  const plan = new FaultPlan({ log, prng: createPrng(seed).fork('plan') });
  const tenantNames = options.tenants ?? ['acme', 'beta'];
  const tenants = tenantNames.map((t) => TenantId.parse(t));
  const workerIntervalMs = options.workerIntervalMs ?? 50;
  const retention = retentionFor(options.retention ?? 'off');
  const retentionDeletes = retention.wallet.enabled && !retention.wallet.dryRun;
  // Xác nhận thành công phía client (xem Expectations); chỉ ghi khi nhận phản hồi 2xx.
  const ordersPaid = new Set<string>();
  const topupsCreated = new Set<string>();
  const opsActionIds = new Set<string>();
  const expectations: Expectations = {
    ordersPaid,
    topupsCreated,
    opsActionIds,
    get opsActions() {
      return opsActionIds.size;
    },
  };
  let receivedCursor = 0;
  // Ghi các OrderPaidV1 Orders giả đã nhận (từ lần ghi trước tới giờ). Chỉ gọi ở cuối heal(): trước đó test có thể tự
  // chèn kết quả giả vào simulator.results để thử oracle, nên không đọc liên tục.
  const syncOrdersPaid = (): void => {
    const all = orders?.received() ?? [];
    receivedCursor = Math.min(receivedCursor, all.length);
    for (const r of all.slice(receivedCursor)) {
      const tenant = r.payload.tenantId;
      const orderId = r.payload.orderId;
      if (
        r.eventType === 'OrderPaidV1' &&
        typeof tenant === 'string' &&
        typeof orderId === 'string'
      ) {
        ordersPaid.add(`${tenant}/${orderId}`);
      }
    }
    receivedCursor = all.length;
  };

  // Tài nguyên được gán dần; stop() dọn đúng những gì đã dựng xong (kể cả khi createSystem hỏng giữa chừng).
  let walletDbHandle: TestDatabase | undefined;
  let paymentDbHandle: TestDatabase | undefined;
  let walletAdmin: Kysely<unknown> | undefined;
  let paymentAdmin: Kysely<unknown> | undefined;
  let broker: TestBroker | undefined;
  let orders: OrdersSimulator | undefined;
  let walletToPayment: HttpFaultProxy | undefined;
  let paymentToWallet: HttpFaultProxy | undefined;
  let wallet: Handle | undefined;
  let payment: Handle | undefined;
  // Mọi tiến trình con từng sinh (kể cả đã bị crash): stop() giết và xác nhận từng pid không còn tồn tại.
  const allChildren: ChildService[] = [];
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
      // Tiến trình con: giết cứng từng cái (idempotent) rồi xác nhận pid đã biến mất, để không bao giờ để mồ côi.
      for (const child of allChildren) {
        await step(() => child.kill());
        if (isProcessAlive(child.pid)) {
          errors.push(
            new Error(`tiến trình con ${child.name} (pid ${child.pid}) vẫn còn sau stop()`),
          );
        }
      }
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

    // Một cấu hình duy nhất cho cả hai chế độ: inproc truyền thẳng, child đổi sang biến môi trường (service-config.ts).
    const walletConfig = walletConfigFor({
      port: walletPort,
      database: walletDbConfig,
      tenants,
      paymentBaseUrl: walletProxyUrl,
      broker: brokerAccess.wallet,
      workerIntervalMs,
      retention: retention.wallet,
      tuning: {
        reconciliation: {
          ...DEFAULT_RECONCILIATION,
          autofix: options.reconciliation?.autofix ?? DEFAULT_RECONCILIATION.autofix,
        },
      },
    });
    const paymentConfig = paymentConfigFor({
      port: paymentPort,
      database: paymentDbConfig,
      webhookUrl,
      workerIntervalMs,
      retention: retention.payment,
    });

    // Sinh tiến trình con rồi chờ /health; chờ hỏng thì giết ngay để không để lại mồ côi.
    const launchChild = async (
      name: 'wallet' | 'payment',
      env: Record<string, string>,
      port: number,
    ): Promise<ChildService> => {
      const child = await spawnChildService({ name, env, port });
      allChildren.push(child);
      try {
        await child.waitReady();
      } catch (error) {
        await child.kill().catch(() => undefined);
        throw error;
      }
      return child;
    };

    const launchWallet = async (): Promise<Handle> => {
      if (mode === 'child') return launchChild('wallet', walletEnv(walletConfig), walletPort);
      const running = await startWallet(walletConfig, {
        wrapDialect: faultyDialect(plan, { name: 'wallet' }),
        wrapPublisher: faultyPublisher(plan),
        ...(options.afterOrderHandled === undefined
          ? {}
          : { afterOrderHandled: options.afterOrderHandled }),
      });
      try {
        await running.app.listen(walletPort, '127.0.0.1');
      } catch (error) {
        await running.stop().catch(() => undefined);
        throw error;
      }
      return running;
    };

    const launchPayment = async (): Promise<Handle> => {
      if (mode === 'child') return launchChild('payment', paymentEnv(paymentConfig), paymentPort);
      const running = await startPayment(paymentConfig, {
        wrapDialect: faultyDialect(plan, { name: 'payment' }),
      });
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

    // Crash thật: SIGKILL rồi đợi thoát; để undefined để heal()/restart*() biết dịch vụ đang chết. Không tự bật lại.
    const crash = async (which: 'wallet' | 'payment'): Promise<void> => {
      const running = which === 'wallet' ? wallet : payment;
      if (running?.kill === undefined) {
        throw new Error(`crash ${which}: không có tiến trình con đang chạy`);
      }
      // Chỉ bỏ handle SAU khi kill xong: kill lỗi/quá hạn thì handle vẫn còn, heal() không dựng thêm bản thứ hai đè cổng.
      await running.kill();
      if (which === 'wallet') wallet = undefined;
      else payment = undefined;
      log.record('crash', { service: which, pid: running.pid });
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

    const conditions = (allowUnsettledTopups: boolean): QuiesceCondition[] => {
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
        if (allowUnsettledTopups) continue;
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

    const heal = async (
      healOptions: { timeoutMs?: number; allowUnsettledTopups?: boolean } = {},
    ): Promise<void> => {
      plan.disable();
      log.record('heal.start');
      if (payment === undefined) payment = await launchPayment();
      if (wallet === undefined) wallet = await launchWallet();
      await quiesce(conditions(healOptions.allowUnsettledTopups === true), {
        timeoutMs: healOptions.timeoutMs ?? HEAL_TIMEOUT_MS,
      });
      syncOrdersPaid();
      log.record('heal.done');
    };

    const wallets = (tenant: string, customer: string, key?: string) => ({
      url: walletUrl,
      headers: walletHeaders(tenant, customer, key),
    });

    const system: System = {
      mode,
      seed,
      retentionDeletes,
      expectations,
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
        if (response.ok && body.topupId !== undefined) {
          topupsCreated.add(`${tenant}/${body.topupId}`);
        }
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
        // Thao tác ghi đã được ops_actions xác nhận khi phản hồi 2xx có actionId (freeze không đổi trạng thái trả actionId null).
        if (response.ok && body !== undefined && typeof parsed === 'object' && parsed !== null) {
          const actionId = (parsed as { actionId?: unknown }).actionId;
          if (typeof actionId === 'string') opsActionIds.add(`${tenant}/${actionId}`);
        }
        return { status: response.status, body: parsed };
      },
      restartWallet,
      restartPayment,
      heal,
      stop,
    };
    if (mode !== 'child') return system;
    const childSystem: ChildSystem = {
      ...system,
      mode: 'child',
      crashWallet: () => crash('wallet'),
      crashPayment: () => crash('payment'),
      pids: () => ({
        ...(wallet?.pid === undefined ? {} : { wallet: wallet.pid }),
        ...(payment?.pid === undefined ? {} : { payment: payment.pid }),
      }),
    };
    return childSystem;
  } catch (error) {
    // Dựng dở thì dọn phần đã dựng rồi ném lại lỗi gốc (lỗi dọn không được che lỗi gốc).
    await stop().catch(() => undefined);
    throw error;
  }
}
