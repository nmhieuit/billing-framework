import { ConfigError, databaseConfigFromEnv, type DatabaseConfig } from '@billing/database';

export interface PaymentConfig {
  port: number;
  database: DatabaseConfig;
  webhook: { url: string; secret: string; backoffSeconds: number[] };
  workerIntervalMs: number;
  responseTimeoutMs: number;
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

  if (problems.length > 0 || database === undefined || backoffSeconds === undefined) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    webhook: { url, secret, backoffSeconds },
    workerIntervalMs,
    responseTimeoutMs,
  };
}
