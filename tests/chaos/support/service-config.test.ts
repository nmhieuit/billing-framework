import { describe, expect, it } from 'vitest';
import { loadConfig as loadPaymentConfig } from '../../../services/payment/src/config.js';
import { loadConfig as loadWalletConfig } from '../../../services/wallet/src/config.js';
import { TenantId } from '../../../services/wallet/src/domain/tenant-id.js';
import {
  paymentConfigFor,
  paymentEnv,
  retentionFor,
  walletConfigFor,
  walletEnv,
} from './service-config.js';

const database = {
  host: '127.0.0.1',
  port: 14330,
  database: 'chaos_x',
  user: 'sa',
  password: 'Pa55-test',
};
const broker = {
  host: '127.0.0.1',
  port: 56720,
  vhost: 'chaos_v',
  user: 'billing_wallet',
  password: 'wallet-test-password',
};

// poolMax không có biến môi trường (child dùng mặc định), nên bỏ khỏi phép so sánh.
const withoutPoolMax = ({ poolMax, ...rest }: typeof database & { poolMax?: number }) => {
  void poolMax;
  return rest;
};

describe('service-config: một nguồn cấu hình cho cả chế độ inproc và child', () => {
  // Mọi giá trị dưới đây KHÁC mặc định của loadConfig: gõ sai tên biến env sẽ rơi về mặc định và làm test đỏ.
  const walletRetention = {
    enabled: false,
    dryRun: false,
    intervalMinutes: 3,
    maxSecondsPerRun: 11,
    batchSize: 7,
    days: { outboxSent: 5, processedMessages: 10, idempotencyKeys: 20, reconciliation: 40 },
  };
  const paymentRetention = {
    enabled: false,
    dryRun: false,
    intervalMinutes: 4,
    maxSecondsPerRun: 12,
    batchSize: 9,
    days: { webhook: 6, idempotencyKeys: 21 },
  };
  const walletInput = () => ({
    port: 4101,
    database: { ...database, poolMax: 4 },
    tenants: [TenantId.parse('acme'), TenantId.parse('beta')],
    paymentBaseUrl: 'http://127.0.0.1:4999',
    broker,
    workerIntervalMs: 50,
    retention: walletRetention,
    tuning: {
      paymentTimeoutMs: 2222,
      topupBackoffSeconds: [2, 4, 8],
      orders: { prefetch: 3, retryDelaysSeconds: [3, 6], outboxBatch: 7 },
      reconciliation: { autofix: false, atUtcHour: 5, maxAttempts: 4, maxItems: 321 },
      telemetry: { sampleIntervalSeconds: 20 },
    },
  });
  const paymentInput = () => ({
    port: 4102,
    database: { ...database, poolMax: 4 },
    webhookUrl: 'http://127.0.0.1:4998/webhooks/payment',
    workerIntervalMs: 50,
    retention: paymentRetention,
    tuning: {
      webhookBackoffSeconds: [2, 4],
      responseTimeoutMs: 1234,
      telemetry: { sampleIntervalSeconds: 20 },
    },
  });

  it('walletEnv() đọc lại qua loadConfig() ra đúng cấu hình ban đầu (trừ poolMax)', () => {
    const config = walletConfigFor(walletInput());
    const loaded = loadWalletConfig(walletEnv(config));
    expect(loaded).toEqual({ ...config, database: withoutPoolMax(config.database) });
  });

  it('paymentEnv() đọc lại qua loadConfig() ra đúng cấu hình ban đầu (trừ poolMax)', () => {
    const config = paymentConfigFor(paymentInput());
    const loaded = loadPaymentConfig(paymentEnv(config));
    expect(loaded).toEqual({ ...config, database: withoutPoolMax(config.database) });
  });

  it('đổi tên một biến env làm giá trị rơi về mặc định (nên phép so sánh ở trên bắt được typo)', () => {
    const rename = (env: Record<string, string>, from: string, to: string) =>
      Object.fromEntries(Object.entries(env).map(([k, v]) => [k === from ? to : k, v]));
    const wallet = walletEnv(walletConfigFor(walletInput()));
    expect(
      loadWalletConfig(rename(wallet, 'OUTBOX_BATCH', 'OUTBOX_BATC')).orders.outboxBatch,
    ).not.toBe(7);
    const payment = paymentEnv(paymentConfigFor(paymentInput()));
    expect(
      loadPaymentConfig(rename(payment, 'RESPONSE_TIMEOUT_MS', 'RESPONSE_TIMEOUT'))
        .responseTimeoutMs,
    ).not.toBe(1234);
  });
  it('không đặt OTEL_EXPORTER_OTLP_ENDPOINT cho tiến trình con', () => {
    const config = walletConfigFor({
      port: 4101,
      database,
      tenants: [TenantId.parse('acme')],
      paymentBaseUrl: 'http://127.0.0.1:4999',
      broker,
      workerIntervalMs: 50,
      retention: retentionFor('off').wallet,
    });
    expect(Object.keys(walletEnv(config)).some((k) => k.startsWith('OTEL_'))).toBe(false);
  });
});
