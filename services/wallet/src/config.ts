import { ConfigError, databaseConfigFromEnv, type DatabaseConfig } from '@billing/database';
import type { BrokerConfig } from '@billing/messaging';
import { InvalidTenantError } from './domain/errors.js';
import { TenantId } from './domain/tenant-id.js';

export interface ReconciliationConfig {
  autofix: boolean;
  atUtcHour: number;
  maxAttempts: number;
  maxItems: number;
}

export interface WalletRetentionConfig {
  enabled: boolean;
  dryRun: boolean;
  intervalMinutes: number;
  maxSecondsPerRun: number;
  batchSize: number;
  days: {
    outboxSent: number;
    processedMessages: number;
    idempotencyKeys: number;
    reconciliation: number;
  };
}

export interface WalletConfig {
  port: number;
  database: DatabaseConfig;
  tenants: TenantId[];
  payment: { baseUrl: string; webhookSecret: string; timeoutMs: number };
  broker: BrokerConfig;
  orders: { prefetch: number; retryDelaysSeconds: number[]; outboxBatch: number };
  reconciliation: ReconciliationConfig;
  retention: WalletRetentionConfig;
  topupBackoffSeconds: number[];
  workerIntervalMs: number;
  telemetry: { sampleIntervalSeconds: number };
}

const DEFAULT_BACKOFF = '1,5,30,120,600';
const DEFAULT_ORDER_RETRY_DELAYS = '5,30,120,600,1800';

/** Đọc cấu hình từ môi trường; thiếu hoặc sai thì ném ConfigError liệt kê mọi vấn đề cùng lúc. */
export function loadConfig(env: NodeJS.ProcessEnv): WalletConfig {
  const problems: string[] = [];

  let database: DatabaseConfig | undefined;
  try {
    database = databaseConfigFromEnv('WALLET_DB', env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }

  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer in ${min}..${max}`);
      return fallback;
    }
    return value;
  };

  // Cờ boolean "true"/"false"; giá trị lạ bị ghi vào danh sách lỗi cấu hình.
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    problems.push(`${name} must be "true" or "false"`);
    return fallback;
  };

  // WALLET_TENANTS
  const tenants: TenantId[] = [];
  const rawTenants = required('WALLET_TENANTS');
  if (rawTenants !== '') {
    const parts = rawTenants
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) {
      problems.push('WALLET_TENANTS is required');
    }
    const seen = new Set<string>();
    for (const part of parts) {
      try {
        const tenant = TenantId.parse(part);
        if (seen.has(tenant.value)) {
          problems.push(`WALLET_TENANTS contains duplicate tenant "${tenant.value}"`);
          continue;
        }
        seen.add(tenant.value);
        tenants.push(tenant);
      } catch (error) {
        if (!(error instanceof InvalidTenantError)) throw error;
        problems.push(`WALLET_TENANTS contains an invalid tenant id "${part}"`);
      }
    }
  }

  // PAYMENT_BASE_URL
  let baseUrl = required('PAYMENT_BASE_URL');
  if (baseUrl !== '') {
    let valid = false;
    try {
      const parsed = new URL(baseUrl);
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      valid = false;
    }
    if (valid) baseUrl = baseUrl.replace(/\/+$/, '');
    else problems.push('PAYMENT_BASE_URL must be an absolute http(s) URL');
  }

  const webhookSecret = required('PAYMENT_WEBHOOK_SECRET');

  // RabbitMQ
  const brokerHost = required('RABBITMQ_HOST');
  const brokerUser = required('RABBITMQ_USER');
  const brokerPassword = required('RABBITMQ_PASSWORD');
  const brokerPort = integer('RABBITMQ_PORT', 5672, 1, 65535);
  const rawVhost = env.RABBITMQ_VHOST;
  const brokerVhost =
    rawVhost === undefined || rawVhost.trim() === '' ? 'billing' : rawVhost.trim();

  const rawBackoff = env.TOPUP_SUBMIT_BACKOFF;
  const backoffText =
    rawBackoff === undefined || rawBackoff.trim() === '' ? DEFAULT_BACKOFF : rawBackoff;
  const backoffParts = backoffText.split(',').map((part) => part.trim());
  const topupBackoffSeconds = backoffParts.every((part) => /^[1-9]\d{0,5}$/.test(part))
    ? backoffParts.map(Number)
    : undefined;
  if (topupBackoffSeconds === undefined) {
    problems.push(
      'TOPUP_SUBMIT_BACKOFF must be a comma-separated list of positive integers (seconds)',
    );
  }

  const rawRetryDelays = env.ORDER_RETRY_DELAYS;
  const retryText =
    rawRetryDelays === undefined || rawRetryDelays.trim() === ''
      ? DEFAULT_ORDER_RETRY_DELAYS
      : rawRetryDelays;
  const retryParts = retryText.split(',').map((part) => part.trim());
  const retryDelaysSeconds = retryParts.every((part) => /^[1-9]\d{0,5}$/.test(part))
    ? retryParts.map(Number)
    : undefined;
  if (retryDelaysSeconds === undefined) {
    problems.push(
      'ORDER_RETRY_DELAYS must be a comma-separated list of positive integers (seconds)',
    );
  }

  const port = integer('PORT', 3001, 1, 65535);
  const timeoutMs = integer('PAYMENT_TIMEOUT_MS', 5000, 1, 50_000);
  const prefetch = integer('ORDER_CONSUMER_PREFETCH', 10, 1, 1000);
  const outboxBatch = integer('OUTBOX_BATCH', 50, 1, 1000);
  const workerIntervalMs = integer('WORKER_INTERVAL_MS', 500, 1, 3_600_000);
  const sampleIntervalSeconds = integer('METRICS_SAMPLE_INTERVAL_SECONDS', 15, 1, 3600);

  const reconcileAutofix = flag('RECONCILE_AUTOFIX', true);
  const reconcileAtUtcHour = integer('RECONCILE_AT_UTC_HOUR', 2, 0, 23);
  const reconcileMaxAttempts = integer('RECONCILE_MAX_ATTEMPTS', 3, 1, 20);
  const reconcileMaxItems = integer('RECONCILE_MAX_ITEMS', 50_000, 1, 1_000_000);

  // Dọn dữ liệu cũ (retention): mặc định bật nhưng chạy thử.
  const retention: WalletRetentionConfig = {
    enabled: flag('RETENTION_ENABLED', true),
    dryRun: flag('RETENTION_DRY_RUN', true),
    intervalMinutes: integer('RETENTION_INTERVAL_MINUTES', 60, 1, 1440),
    maxSecondsPerRun: integer('RETENTION_MAX_SECONDS_PER_RUN', 60, 1, 3600),
    batchSize: integer('RETENTION_BATCH_SIZE', 1000, 1, 4000),
    days: {
      outboxSent: integer('RETENTION_OUTBOX_SENT_DAYS', 14, 1, 3650),
      processedMessages: integer('RETENTION_PROCESSED_MESSAGES_DAYS', 30, 7, 3650),
      idempotencyKeys: integer('RETENTION_IDEMPOTENCY_KEYS_DAYS', 90, 7, 3650),
      reconciliation: integer('RETENTION_RECONCILIATION_DAYS', 365, 30, 3650),
    },
  };

  if (
    problems.length > 0 ||
    database === undefined ||
    topupBackoffSeconds === undefined ||
    retryDelaysSeconds === undefined
  ) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    tenants,
    payment: { baseUrl, webhookSecret, timeoutMs },
    broker: {
      host: brokerHost,
      port: brokerPort,
      vhost: brokerVhost,
      user: brokerUser,
      password: brokerPassword,
    },
    orders: { prefetch, retryDelaysSeconds, outboxBatch },
    reconciliation: {
      autofix: reconcileAutofix,
      atUtcHour: reconcileAtUtcHour,
      maxAttempts: reconcileMaxAttempts,
      maxItems: reconcileMaxItems,
    },
    retention,
    topupBackoffSeconds,
    workerIntervalMs,
    telemetry: { sampleIntervalSeconds },
  };
}
