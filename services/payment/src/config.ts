import { ConfigError, databaseConfigFromEnv, type DatabaseConfig } from '@billing/database';

export interface PaymentRetentionConfig {
  enabled: boolean;
  dryRun: boolean;
  intervalMinutes: number;
  maxSecondsPerRun: number;
  batchSize: number;
  days: { webhook: number; idempotencyKeys: number };
}

export interface PaymentConfig {
  port: number;
  database: DatabaseConfig;
  webhook: { url: string; secret: string; backoffSeconds: number[] };
  workerIntervalMs: number;
  responseTimeoutMs: number;
  retention: PaymentRetentionConfig;
  telemetry: { sampleIntervalSeconds: number };
}

const DEFAULT_BACKOFF = '1,5,30,120,600';

/** Đọc cấu hình từ môi trường; thiếu hoặc sai thì ném ConfigError liệt kê mọi vấn đề cùng lúc. */
export function loadConfig(env: NodeJS.ProcessEnv): PaymentConfig {
  const problems: string[] = [];

  let database: DatabaseConfig | undefined;
  try {
    database = databaseConfigFromEnv('PAYMENT_DB', env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }

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

  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };

  const url = required('WEBHOOK_URL');
  if (url !== '') {
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      valid = false;
    }
    if (!valid) problems.push('WEBHOOK_URL must be an absolute http(s) URL');
  }
  const secret = required('WEBHOOK_SECRET');

  const rawBackoff = env.WEBHOOK_BACKOFF;
  const backoffText =
    rawBackoff === undefined || rawBackoff.trim() === '' ? DEFAULT_BACKOFF : rawBackoff;
  const backoffParts = backoffText.split(',').map((part) => part.trim());
  const backoffSeconds = backoffParts.every((part) => /^[1-9]\d{0,5}$/.test(part))
    ? backoffParts.map(Number)
    : undefined;
  if (backoffSeconds === undefined) {
    problems.push('WEBHOOK_BACKOFF must be a comma-separated list of positive integers (seconds)');
  }

  const port = integer('PORT', 3002, 1, 65535);
  const workerIntervalMs = integer('WORKER_INTERVAL_MS', 500, 1, 3_600_000);
  const responseTimeoutMs = integer('RESPONSE_TIMEOUT_MS', 30_000, 0, 3_600_000);
  const sampleIntervalSeconds = integer('METRICS_SAMPLE_INTERVAL_SECONDS', 15, 1, 3600);

  // Dọn dữ liệu cũ (retention): mặc định bật nhưng chạy thử.
  const retention: PaymentRetentionConfig = {
    enabled: flag('RETENTION_ENABLED', true),
    dryRun: flag('RETENTION_DRY_RUN', true),
    intervalMinutes: integer('RETENTION_INTERVAL_MINUTES', 60, 1, 1440),
    maxSecondsPerRun: integer('RETENTION_MAX_SECONDS_PER_RUN', 60, 1, 3600),
    batchSize: integer('RETENTION_BATCH_SIZE', 1000, 1, 4000),
    days: {
      webhook: integer('RETENTION_WEBHOOK_DAYS', 30, 1, 3650),
      idempotencyKeys: integer('RETENTION_IDEMPOTENCY_KEYS_DAYS', 90, 7, 3650),
    },
  };

  if (problems.length > 0 || database === undefined || backoffSeconds === undefined) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    webhook: { url, secret, backoffSeconds },
    workerIntervalMs,
    responseTimeoutMs,
    retention,
    telemetry: { sampleIntervalSeconds },
  };
}
