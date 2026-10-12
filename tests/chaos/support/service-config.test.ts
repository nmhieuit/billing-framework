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
  it('walletEnv() đọc lại qua loadConfig() ra đúng cấu hình ban đầu (trừ poolMax)', () => {
    const config = walletConfigFor({
      port: 4101,
      database: { ...database, poolMax: 4 },
      tenants: [TenantId.parse('acme'), TenantId.parse('beta')],
      paymentBaseUrl: 'http://127.0.0.1:4999',
      broker,
      workerIntervalMs: 50,
      retention: retentionFor({ dryRun: false, batchSize: 7, intervalMinutes: 3 }).wallet,
    });
    const loaded = loadWalletConfig(walletEnv(config));
    expect(loaded).toEqual({ ...config, database: withoutPoolMax(config.database) });
  });

  it('paymentEnv() đọc lại qua loadConfig() ra đúng cấu hình ban đầu (trừ poolMax)', () => {
    const config = paymentConfigFor({
      port: 4102,
      database: { ...database, poolMax: 4 },
      webhookUrl: 'http://127.0.0.1:4998/webhooks/payment',
      workerIntervalMs: 50,
      retention: retentionFor('off').payment,
    });
    const loaded = loadPaymentConfig(paymentEnv(config));
    expect(loaded).toEqual({ ...config, database: withoutPoolMax(config.database) });
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
