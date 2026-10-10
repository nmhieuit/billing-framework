import { ConfigError } from '@billing/database';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const minimal = {
  WALLET_DB_HOST: 'db',
  WALLET_DB_NAME: 'billing_wallet',
  WALLET_DB_USER: 'u',
  WALLET_DB_PASSWORD: 'p',
  WALLET_TENANTS: 'acme,beta',
  PAYMENT_BASE_URL: 'http://payment:3002/',
  PAYMENT_WEBHOOK_SECRET: 'whsec_x',
  RABBITMQ_HOST: 'mq',
  RABBITMQ_USER: 'billing_wallet',
  RABBITMQ_PASSWORD: 'mq-secret',
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as ConfigError).problems;
  }
  return [];
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(minimal);
    expect(config).toMatchObject({
      port: 3001,
      database: { host: 'db', port: 1433, database: 'billing_wallet', user: 'u', password: 'p' },
      payment: { baseUrl: 'http://payment:3002', webhookSecret: 'whsec_x', timeoutMs: 5000 },
      broker: {
        host: 'mq',
        port: 5672,
        vhost: 'billing',
        user: 'billing_wallet',
        password: 'mq-secret',
      },
      orders: { prefetch: 10, retryDelaysSeconds: [5, 30, 120, 600, 1800], outboxBatch: 50 },
      topupBackoffSeconds: [1, 5, 30, 120, 600],
      workerIntervalMs: 500,
    });
    expect(config.tenants.map((t) => t.value)).toEqual(['acme', 'beta']);
  });

  it('reads overrides and trims spaces around tenants', () => {
    const config = loadConfig({
      ...minimal,
      WALLET_TENANTS: ' acme , beta',
      PORT: '4001',
      WALLET_DB_PORT: '14333',
      PAYMENT_TIMEOUT_MS: '250',
      TOPUP_SUBMIT_BACKOFF: '2, 4',
      WORKER_INTERVAL_MS: '50',
    });
    expect(config).toMatchObject({
      port: 4001,
      database: { port: 14333 },
      payment: { timeoutMs: 250 },
      topupBackoffSeconds: [2, 4],
      workerIntervalMs: 50,
    });
    expect(config.tenants.map((t) => t.value)).toEqual(['acme', 'beta']);
  });

  it('refuses to start without the required settings and lists them all, in a fixed order', () => {
    expect(problemsOf({})).toEqual([
      'WALLET_DB_HOST is required',
      'WALLET_DB_NAME is required',
      'WALLET_DB_USER is required',
      'WALLET_DB_PASSWORD is required',
      'WALLET_TENANTS is required',
      'PAYMENT_BASE_URL is required',
      'PAYMENT_WEBHOOK_SECRET is required',
      'RABBITMQ_HOST is required',
      'RABBITMQ_USER is required',
      'RABBITMQ_PASSWORD is required',
    ]);
  });

  it('applies the reconciliation defaults and reads overrides', () => {
    expect(loadConfig(minimal).reconciliation).toEqual({
      autofix: true,
      atUtcHour: 2,
      maxAttempts: 3,
      maxItems: 50_000,
    });
    expect(
      loadConfig({
        ...minimal,
        RECONCILE_AUTOFIX: 'false',
        RECONCILE_AT_UTC_HOUR: '23',
        RECONCILE_MAX_ATTEMPTS: '5',
        RECONCILE_MAX_ITEMS: '100',
      }).reconciliation,
    ).toEqual({ autofix: false, atUtcHour: 23, maxAttempts: 5, maxItems: 100 });
  });

  it('rejects invalid reconciliation settings together', () => {
    expect(
      problemsOf({
        ...minimal,
        RECONCILE_AUTOFIX: 'yes',
        RECONCILE_AT_UTC_HOUR: '24',
        RECONCILE_MAX_ATTEMPTS: '0',
        RECONCILE_MAX_ITEMS: '1000001',
      }),
    ).toEqual([
      'RECONCILE_AUTOFIX must be "true" or "false"',
      'RECONCILE_AT_UTC_HOUR must be an integer in 0..23',
      'RECONCILE_MAX_ATTEMPTS must be an integer in 1..20',
      'RECONCILE_MAX_ITEMS must be an integer in 1..1000000',
    ]);
  });

  it('has no default for the secret and treats blank as missing', () => {
    expect(problemsOf({ ...minimal, PAYMENT_WEBHOOK_SECRET: '  ' })).toEqual([
      'PAYMENT_WEBHOOK_SECRET is required',
    ]);
  });

  it.each(['ftp://x', 'not a url', 'payment:3002'])('rejects PAYMENT_BASE_URL %j', (url) => {
    expect(problemsOf({ ...minimal, PAYMENT_BASE_URL: url })).toEqual([
      'PAYMENT_BASE_URL must be an absolute http(s) URL',
    ]);
  });

  it('rejects an invalid tenant id and duplicate tenants', () => {
    expect(problemsOf({ ...minimal, WALLET_TENANTS: 'acme,Bad_Tenant' })).toEqual([
      'WALLET_TENANTS contains an invalid tenant id "Bad_Tenant"',
    ]);
    expect(problemsOf({ ...minimal, WALLET_TENANTS: 'acme,acme' })).toEqual([
      'WALLET_TENANTS contains duplicate tenant "acme"',
    ]);
    expect(problemsOf({ ...minimal, WALLET_TENANTS: ' , ' })).toEqual([
      'WALLET_TENANTS is required',
    ]);
  });

  it.each(['', '1,a', '0', '-1', '1.5', '1,,2'])('handles TOPUP_SUBMIT_BACKOFF %j', (value) => {
    const problems = problemsOf({ ...minimal, TOPUP_SUBMIT_BACKOFF: value });
    // Chuỗi rỗng được coi như không đặt (dùng mặc định).
    expect(problems).toEqual(
      value === ''
        ? []
        : ['TOPUP_SUBMIT_BACKOFF must be a comma-separated list of positive integers (seconds)'],
    );
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PAYMENT_TIMEOUT_MS', '0'],
    ['PAYMENT_TIMEOUT_MS', '999999'],
    ['PAYMENT_TIMEOUT_MS', '50001'],
    ['WORKER_INTERVAL_MS', '0'],
    ['WORKER_INTERVAL_MS', 'abc'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf({ ...minimal, [name]: value })).toEqual([
      expect.stringContaining(`${name} must be an integer`),
    ]);
  });

  it('states the 1..50000 range for PAYMENT_TIMEOUT_MS and accepts its upper bound', () => {
    expect(problemsOf({ ...minimal, PAYMENT_TIMEOUT_MS: '50001' })).toEqual([
      'PAYMENT_TIMEOUT_MS must be an integer in 1..50000',
    ]);
    expect(problemsOf({ ...minimal, PAYMENT_TIMEOUT_MS: '50000' })).toEqual([]);
  });

  it('reads the broker and order-consumer overrides', () => {
    const config = loadConfig({
      ...minimal,
      RABBITMQ_PORT: '5673',
      RABBITMQ_VHOST: 'other',
      ORDER_CONSUMER_PREFETCH: '3',
      ORDER_RETRY_DELAYS: '2, 4',
      OUTBOX_BATCH: '7',
    });
    expect(config).toMatchObject({
      broker: { port: 5673, vhost: 'other' },
      orders: { prefetch: 3, retryDelaysSeconds: [2, 4], outboxBatch: 7 },
    });
  });

  it('never has a default for the broker password and treats blank as missing', () => {
    expect(problemsOf({ ...minimal, RABBITMQ_PASSWORD: ' ' })).toEqual([
      'RABBITMQ_PASSWORD is required',
    ]);
  });

  it.each([
    ['RABBITMQ_PORT', '0'],
    ['RABBITMQ_PORT', 'abc'],
    ['ORDER_CONSUMER_PREFETCH', '0'],
    ['ORDER_CONSUMER_PREFETCH', '1001'],
    ['OUTBOX_BATCH', '0'],
    ['OUTBOX_BATCH', 'x'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf({ ...minimal, [name]: value })).toEqual([
      expect.stringContaining(`${name} must be an integer`),
    ]);
  });

  it.each(['1,a', '0', '-1', '1.5', '1,,2'])('rejects ORDER_RETRY_DELAYS %j', (value) => {
    expect(problemsOf({ ...minimal, ORDER_RETRY_DELAYS: value })).toEqual([
      'ORDER_RETRY_DELAYS must be a comma-separated list of positive integers (seconds)',
    ]);
  });

  it('rejects an empty RABBITMQ_VHOST override', () => {
    expect(loadConfig({ ...minimal, RABBITMQ_VHOST: '  ' }).broker.vhost).toBe('billing');
  });

  it('reports a bad database port together with the other problems', () => {
    expect(problemsOf({ ...minimal, WALLET_DB_PORT: 'x', PAYMENT_WEBHOOK_SECRET: '' })).toEqual([
      'WALLET_DB_PORT must be an integer in 1..65535',
      'PAYMENT_WEBHOOK_SECRET is required',
    ]);
  });
});
