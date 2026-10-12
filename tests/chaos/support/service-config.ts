import type { DatabaseConfig } from '@billing/database';
import type {
  PaymentConfig,
  PaymentRetentionConfig,
} from '../../../services/payment/src/config.js';
import type { WalletConfig, WalletRetentionConfig } from '../../../services/wallet/src/config.js';
import type { TenantId } from '../../../services/wallet/src/domain/tenant-id.js';

/**
 * Cấu hình dịch vụ cho harness chaos, đặt MỘT chỗ: chế độ inproc truyền thẳng đối tượng cấu hình vào
 * startService(), chế độ child đổi chính đối tượng đó thành biến môi trường (walletEnv/paymentEnv) cho tiến trình con.
 * Test service-config.test.ts đọc env lại qua loadConfig() thật để chắc hai chế độ không lệch nhau.
 */

export const SECRET = 'whsec_chaos';
export const BACKOFF_SECONDS = [1, 2, 3];

/** Đối soát mặc định của harness: tự ghi bù (autofix) bật; bản thân lượt tự động 23h UTC hầu như không chạy trong test. */
export const DEFAULT_RECONCILIATION: WalletConfig['reconciliation'] = {
  autofix: true,
  atUtcHour: 23,
  maxAttempts: 3,
  maxItems: 1000,
};

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

export function retentionFor(option: RetentionOption): {
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

export function walletConfigFor(input: {
  port: number;
  database: DatabaseConfig;
  tenants: TenantId[];
  paymentBaseUrl: string;
  broker: WalletConfig['broker'];
  workerIntervalMs: number;
  retention: WalletRetentionConfig;
  /** Ghi đè giá trị cố định của harness (chỉ test cấu hình dùng, để kiểm env bằng giá trị khác mặc định). */
  tuning?: Partial<
    Pick<WalletConfig, 'orders' | 'reconciliation' | 'telemetry' | 'topupBackoffSeconds'>
  > & {
    paymentTimeoutMs?: number;
  };
}): WalletConfig {
  return {
    port: input.port,
    database: input.database,
    tenants: input.tenants,
    payment: {
      baseUrl: input.paymentBaseUrl,
      webhookSecret: SECRET,
      timeoutMs: input.tuning?.paymentTimeoutMs ?? 3000,
    },
    broker: input.broker,
    orders: input.tuning?.orders ?? { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
    reconciliation: input.tuning?.reconciliation ?? DEFAULT_RECONCILIATION,
    retention: input.retention,
    topupBackoffSeconds: input.tuning?.topupBackoffSeconds ?? BACKOFF_SECONDS,
    workerIntervalMs: input.workerIntervalMs,
    telemetry: input.tuning?.telemetry ?? { sampleIntervalSeconds: 15 },
  };
}

export function paymentConfigFor(input: {
  port: number;
  database: DatabaseConfig;
  webhookUrl: string;
  workerIntervalMs: number;
  retention: PaymentRetentionConfig;
  tuning?: Partial<Pick<PaymentConfig, 'responseTimeoutMs' | 'telemetry'>> & {
    webhookBackoffSeconds?: number[];
  };
}): PaymentConfig {
  return {
    port: input.port,
    database: input.database,
    webhook: {
      url: input.webhookUrl,
      secret: SECRET,
      backoffSeconds: input.tuning?.webhookBackoffSeconds ?? BACKOFF_SECONDS,
    },
    workerIntervalMs: input.workerIntervalMs,
    responseTimeoutMs: input.tuning?.responseTimeoutMs ?? 1000,
    retention: input.retention,
    telemetry: input.tuning?.telemetry ?? { sampleIntervalSeconds: 15 },
  };
}

const list = (values: readonly number[]): string => values.join(',');

/** Biến môi trường tương ứng cấu hình wallet (tên biến theo services/wallet/.env.example). Không đặt OTEL_*. */
export function walletEnv(config: WalletConfig): Record<string, string> {
  const r = config.retention;
  return {
    PORT: String(config.port),
    WALLET_DB_HOST: config.database.host,
    WALLET_DB_PORT: String(config.database.port),
    WALLET_DB_NAME: config.database.database,
    WALLET_DB_USER: config.database.user,
    WALLET_DB_PASSWORD: config.database.password,
    WALLET_TENANTS: config.tenants.map((t) => t.value).join(','),
    PAYMENT_BASE_URL: config.payment.baseUrl,
    PAYMENT_WEBHOOK_SECRET: config.payment.webhookSecret,
    PAYMENT_TIMEOUT_MS: String(config.payment.timeoutMs),
    RABBITMQ_HOST: config.broker.host,
    RABBITMQ_PORT: String(config.broker.port),
    RABBITMQ_VHOST: config.broker.vhost,
    RABBITMQ_USER: config.broker.user,
    RABBITMQ_PASSWORD: config.broker.password,
    TOPUP_SUBMIT_BACKOFF: list(config.topupBackoffSeconds),
    ORDER_RETRY_DELAYS: list(config.orders.retryDelaysSeconds),
    ORDER_CONSUMER_PREFETCH: String(config.orders.prefetch),
    OUTBOX_BATCH: String(config.orders.outboxBatch),
    WORKER_INTERVAL_MS: String(config.workerIntervalMs),
    METRICS_SAMPLE_INTERVAL_SECONDS: String(config.telemetry.sampleIntervalSeconds),
    RECONCILE_AUTOFIX: String(config.reconciliation.autofix),
    RECONCILE_AT_UTC_HOUR: String(config.reconciliation.atUtcHour),
    RECONCILE_MAX_ATTEMPTS: String(config.reconciliation.maxAttempts),
    RECONCILE_MAX_ITEMS: String(config.reconciliation.maxItems),
    RETENTION_ENABLED: String(r.enabled),
    RETENTION_DRY_RUN: String(r.dryRun),
    RETENTION_INTERVAL_MINUTES: String(r.intervalMinutes),
    RETENTION_MAX_SECONDS_PER_RUN: String(r.maxSecondsPerRun),
    RETENTION_BATCH_SIZE: String(r.batchSize),
    RETENTION_OUTBOX_SENT_DAYS: String(r.days.outboxSent),
    RETENTION_PROCESSED_MESSAGES_DAYS: String(r.days.processedMessages),
    RETENTION_IDEMPOTENCY_KEYS_DAYS: String(r.days.idempotencyKeys),
    RETENTION_RECONCILIATION_DAYS: String(r.days.reconciliation),
  };
}

/** Biến môi trường tương ứng cấu hình payment (tên biến theo services/payment/.env.example). Không đặt OTEL_*. */
export function paymentEnv(config: PaymentConfig): Record<string, string> {
  const r = config.retention;
  return {
    PORT: String(config.port),
    PAYMENT_DB_HOST: config.database.host,
    PAYMENT_DB_PORT: String(config.database.port),
    PAYMENT_DB_NAME: config.database.database,
    PAYMENT_DB_USER: config.database.user,
    PAYMENT_DB_PASSWORD: config.database.password,
    WEBHOOK_URL: config.webhook.url,
    WEBHOOK_SECRET: config.webhook.secret,
    WEBHOOK_BACKOFF: list(config.webhook.backoffSeconds),
    WORKER_INTERVAL_MS: String(config.workerIntervalMs),
    RESPONSE_TIMEOUT_MS: String(config.responseTimeoutMs),
    METRICS_SAMPLE_INTERVAL_SECONDS: String(config.telemetry.sampleIntervalSeconds),
    RETENTION_ENABLED: String(r.enabled),
    RETENTION_DRY_RUN: String(r.dryRun),
    RETENTION_INTERVAL_MINUTES: String(r.intervalMinutes),
    RETENTION_MAX_SECONDS_PER_RUN: String(r.maxSecondsPerRun),
    RETENTION_BATCH_SIZE: String(r.batchSize),
    RETENTION_WEBHOOK_DAYS: String(r.days.webhook),
    RETENTION_IDEMPOTENCY_KEYS_DAYS: String(r.days.idempotencyKeys),
  };
}
