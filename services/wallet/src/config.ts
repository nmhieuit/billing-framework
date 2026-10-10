import { ConfigError, databaseConfigFromEnv, type DatabaseConfig } from '@billing/database';
import { InvalidTenantError } from './domain/errors.js';
import { TenantId } from './domain/tenant-id.js';

export interface WalletConfig {
  port: number;
  database: DatabaseConfig;
  tenants: TenantId[];
  payment: { baseUrl: string; webhookSecret: string; timeoutMs: number };
  topupBackoffSeconds: number[];
  workerIntervalMs: number;
}

const DEFAULT_BACKOFF = '1,5,30,120,600';

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

  const port = integer('PORT', 3001, 1, 65535);
  const timeoutMs = integer('PAYMENT_TIMEOUT_MS', 5000, 1, 120_000);
  const workerIntervalMs = integer('WORKER_INTERVAL_MS', 500, 1, 3_600_000);

  if (problems.length > 0 || database === undefined || topupBackoffSeconds === undefined) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    tenants,
    payment: { baseUrl, webhookSecret, timeoutMs },
    topupBackoffSeconds,
    workerIntervalMs,
  };
}
