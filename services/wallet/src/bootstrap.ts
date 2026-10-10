import { createDatabase } from '@billing/database';
import { BrokerClient } from '@billing/messaging';
import { createLogger } from '@billing/observability';
import { Worker, once, runAll } from '@billing/runtime';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Kysely } from 'kysely';
import { ApplyPaymentResult } from './application/apply-payment-result.js';
import { BackgroundRuns } from './application/background-runs.js';
import { CreateWallet } from './application/create-wallet.js';
import { GetReconciliationRun } from './application/get-reconciliation-run.js';
import { GetTopup } from './application/get-topup.js';
import { GetWallet } from './application/get-wallet.js';
import { InlineTopupSubmitter } from './application/inline-topup-submitter.js';
import { ListEntries } from './application/list-entries.js';
import { ListReconciliationItems } from './application/list-reconciliation-items.js';
import { PayOrder } from './application/pay-order.js';
import type { Clock, IdGenerator, Logger } from './application/ports.js';
import { DEFAULT_OUTBOX_BACKOFF_SECONDS, RelayOutbox } from './application/relay-outbox.js';
import { RequestTopup } from './application/request-topup.js';
import { ResolveReconciliationItem } from './application/resolve-reconciliation-item.js';
import { RunReconciliation } from './application/run-reconciliation.js';
import { ScheduleDailyReconciliation } from './application/schedule-daily-reconciliation.js';
import { StartManualReconciliation } from './application/start-manual-reconciliation.js';
import { SubmitDueTopups } from './application/submit-due-topups.js';
import { SubmitTopup } from './application/submit-topup.js';
import type { WalletConfig } from './config.js';
import { AmqpEventPublisher } from './infrastructure/amqp-event-publisher.js';
import { HttpPaymentGateway } from './infrastructure/http-payment-gateway.js';
import { HttpSettlementSource } from './infrastructure/http-settlement-source.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';
import { assertMigrated } from './infrastructure/kysely/provisioning.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { RandomIdGenerator, SystemClock } from './infrastructure/system.js';
import { ConfigTenantRegistry } from './infrastructure/tenant-registry.js';
import { createApp } from './interface/http/create-app.js';
import { createOrderReadyHandler } from './interface/messaging/order-ready.handler.js';
import { orderPaymentsTopology } from './interface/messaging/order-payments.topology.js';

export interface StartOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  /** Móc cho test: chạy sau khi PayOrder đã commit, trước khi trả ack cho broker (mô phỏng consumer chết giữa chừng). */
  afterOrderHandled?: () => Promise<void>;
}

export interface RunningService {
  app: NestFastifyApplication;
  stop(): Promise<void>;
}

/** Composition root: nối mọi thứ lại và chạy worker nền; app chưa `listen` (main.ts hoặc test tự làm). */
export async function startService(
  config: WalletConfig,
  overrides: StartOverrides = {},
): Promise<RunningService> {
  const pino = createLogger('wallet');
  const log: Logger = {
    info: (details, message) => pino.info(details, message),
    warn: (details, message) => pino.warn(details, message),
    error: (details, message) => pino.error(details, message),
  };
  const db = createDatabase<WalletDatabase>(config.database);

  try {
    // Từ chối chạy khi còn tenant chưa được cấp phát/migrate, kèm thông báo nêu rõ tenant nào còn thiếu gì.
    await assertMigrated(db as unknown as Kysely<unknown>, config.tenants);
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  }

  let broker: BrokerClient;
  try {
    broker = await BrokerClient.connect({ config: config.broker, log, initialMaxRetries: 3 });
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  }

  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new RandomIdGenerator();
  const registry = new ConfigTenantRegistry(config.tenants);
  const uow = new KyselyTenantUnitOfWork(db);
  const gateway = new HttpPaymentGateway({
    baseUrl: config.payment.baseUrl,
    timeoutMs: config.payment.timeoutMs,
  });

  const submit = new SubmitTopup({
    uow,
    gateway,
    clock,
    log,
    backoffSeconds: config.topupBackoffSeconds,
  });
  const submitter = new InlineTopupSubmitter({ submit, log });
  const submitDue = new SubmitDueTopups({ submit });

  // Dùng chung một ApplyPaymentResult cho webhook và đối soát (đường ghi sổ duy nhất, chống trùng sẵn).
  const applyPaymentResult = new ApplyPaymentResult({ uow, clock, ids, log });
  const background = new BackgroundRuns(log);
  const reconciliation = new RunReconciliation({
    uow,
    settlement: new HttpSettlementSource({
      baseUrl: config.payment.baseUrl,
      timeoutMs: config.payment.timeoutMs,
    }),
    applyPayment: applyPaymentResult,
    clock,
    ids,
    log,
    options: {
      autofix: config.reconciliation.autofix,
      maxItems: config.reconciliation.maxItems,
    },
  });
  const scheduleDaily = new ScheduleDailyReconciliation({
    uow,
    run: reconciliation,
    clock,
    log,
    options: {
      atUtcHour: config.reconciliation.atUtcHour,
      maxAttempts: config.reconciliation.maxAttempts,
    },
  });

  const payOrder = new PayOrder({ uow, clock, ids, log });
  const relay = new RelayOutbox({
    uow,
    publisher: new AmqpEventPublisher(broker.publisher),
    clock,
    log,
    backoffSeconds: DEFAULT_OUTBOX_BACKOFF_SECONDS,
  });
  const orderReady = createOrderReadyHandler({ registry, payOrder, log });

  let app: NestFastifyApplication;
  try {
    await broker.consume({
      topology: orderPaymentsTopology(config.orders.retryDelaysSeconds),
      prefetch: config.orders.prefetch,
      handler: async (message) => {
        const result = await orderReady(message);
        await overrides.afterOrderHandled?.();
        return result;
      },
    });
    app = await createApp({
      registry,
      clock,
      log,
      webhookSecret: config.payment.webhookSecret,
      createWallet: new CreateWallet({ uow, clock }),
      getWallet: new GetWallet({ uow }),
      listEntries: new ListEntries({ uow }),
      requestTopup: new RequestTopup({ uow, clock, ids, submitter }),
      getTopup: new GetTopup({ uow }),
      applyPaymentResult,
      startReconciliation: new StartManualReconciliation({ run: reconciliation, background }),
      getReconciliationRun: new GetReconciliationRun({ uow }),
      listReconciliationItems: new ListReconciliationItems({ uow }),
      resolveReconciliationItem: new ResolveReconciliationItem({ uow, clock }),
    });
  } catch (error) {
    await broker.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    throw error;
  }

  // Mỗi tick duyệt từng tenant; lỗi của một tenant không được chặn các tenant còn lại.
  const submitDueForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        const report = await submitDue.execute(tenant, undefined, {
          shouldContinue: () => !signal.aborted,
        });
        if (Object.values(report).some((count) => count > 0)) {
          log.info({ tenantId: tenant.value, ...report }, 'worker submitted due topups');
        }
      } catch (error) {
        log.error({ err: error, tenantId: tenant.value }, 'submitting due topups failed');
      }
    }
  };
  const relayOutboxForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        const report = await relay.execute(tenant, config.orders.outboxBatch, {
          shouldContinue: () => !signal.aborted,
        });
        if (Object.values(report).some((count) => count > 0)) {
          log.info({ tenantId: tenant.value, ...report }, 'worker relayed outbox events');
        }
      } catch (error) {
        log.error({ err: error, tenantId: tenant.value }, 'relaying the outbox failed');
      }
    }
  };
  // Đối soát định kỳ: mỗi tick xét từng tenant; ScheduleDailyReconciliation tự bỏ qua khi chưa tới giờ hoặc đã xong.
  const reconcileDailyForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        const outcome = await scheduleDaily.execute(tenant);
        if (outcome === 'RAN') {
          log.info({ tenantId: tenant.value }, 'worker ran the daily reconciliation');
        }
      } catch (error) {
        log.error(
          { err: error, tenantId: tenant.value },
          'scheduling the daily reconciliation failed',
        );
      }
    }
  };
  const worker = new Worker({
    intervalMs: config.workerIntervalMs,
    tasks: [submitDueForAllTenants, relayOutboxForAllTenants],
    onError: (error) => log.error({ err: error }, 'worker task failed'),
  });
  worker.start();
  // Đối soát có Worker riêng: một lượt dài (đọc sao kê chậm) không được chặn việc gửi lần nạp và relay outbox,
  // và các tick của hai Worker chạy độc lập.
  const reconcileWorker = new Worker({
    intervalMs: config.workerIntervalMs,
    tasks: [reconcileDailyForAllTenants],
    onError: (error) => log.error({ err: error }, 'reconciliation worker task failed'),
  });
  reconcileWorker.start();

  return {
    app,
    stop: once(() =>
      runAll([
        () => broker.stopConsuming(),
        () => worker.stop(),
        () => reconcileWorker.stop(),
        () => app.close(),
        () => submitter.drain(),
        () => background.drain(),
        () => broker.close(),
        () => db.destroy(),
      ]),
    ),
  };
}
