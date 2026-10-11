import { ConfigError } from '@billing/database';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const minimal = {
  PAYMENT_DB_HOST: 'db',
  PAYMENT_DB_NAME: 'billing_payment',
  PAYMENT_DB_USER: 'u',
  PAYMENT_DB_PASSWORD: 'p',
  WEBHOOK_URL: 'http://wallet:3001/webhooks/payment',
  WEBHOOK_SECRET: 'whsec_x',
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
  it('applies documented defaults', () => {
    expect(loadConfig(minimal)).toEqual({
      port: 3002,
      database: { host: 'db', port: 1433, database: 'billing_payment', user: 'u', password: 'p' },
      webhook: {
        url: 'http://wallet:3001/webhooks/payment',
        secret: 'whsec_x',
        backoffSeconds: [1, 5, 30, 120, 600],
      },
      workerIntervalMs: 500,
      responseTimeoutMs: 30000,
      retention: {
        enabled: true,
        dryRun: true,
        intervalMinutes: 60,
        maxSecondsPerRun: 60,
        batchSize: 1000,
        days: { webhook: 30, idempotencyKeys: 90 },
      },
      telemetry: { sampleIntervalSeconds: 15 },
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({
      ...minimal,
      PORT: '4000',
      PAYMENT_DB_PORT: '14333',
      WEBHOOK_BACKOFF: '2, 4,8',
      WORKER_INTERVAL_MS: '50',
      RESPONSE_TIMEOUT_MS: '100',
      METRICS_SAMPLE_INTERVAL_SECONDS: '5',
    });
    expect(config).toMatchObject({
      port: 4000,
      database: { port: 14333 },
      webhook: { backoffSeconds: [2, 4, 8] },
      workerIntervalMs: 50,
      responseTimeoutMs: 100,
      telemetry: { sampleIntervalSeconds: 5 },
    });
  });

  it('reads retention overrides', () => {
    expect(
      loadConfig({
        ...minimal,
        RETENTION_ENABLED: 'false',
        RETENTION_DRY_RUN: 'false',
        RETENTION_INTERVAL_MINUTES: '5',
        RETENTION_MAX_SECONDS_PER_RUN: '10',
        RETENTION_BATCH_SIZE: '4000',
        RETENTION_WEBHOOK_DAYS: '1',
        RETENTION_IDEMPOTENCY_KEYS_DAYS: '7',
      }).retention,
    ).toEqual({
      enabled: false,
      dryRun: false,
      intervalMinutes: 5,
      maxSecondsPerRun: 10,
      batchSize: 4000,
      days: { webhook: 1, idempotencyKeys: 7 },
    });
  });

  it.each([
    ['RETENTION_ENABLED', 'yes', 'RETENTION_ENABLED must be "true" or "false"'],
    ['RETENTION_DRY_RUN', '1', 'RETENTION_DRY_RUN must be "true" or "false"'],
    ['RETENTION_INTERVAL_MINUTES', '0', 'RETENTION_INTERVAL_MINUTES must be an integer in 1..1440'],
    [
      'RETENTION_MAX_SECONDS_PER_RUN',
      '3601',
      'RETENTION_MAX_SECONDS_PER_RUN must be an integer in 1..3600',
    ],
    ['RETENTION_BATCH_SIZE', '4001', 'RETENTION_BATCH_SIZE must be an integer in 1..4000'],
    ['RETENTION_BATCH_SIZE', '1.5', 'RETENTION_BATCH_SIZE must be an integer in 1..4000'],
    ['RETENTION_WEBHOOK_DAYS', '0', 'RETENTION_WEBHOOK_DAYS must be an integer in 1..3650'],
    ['RETENTION_WEBHOOK_DAYS', '3651', 'RETENTION_WEBHOOK_DAYS must be an integer in 1..3650'],
    [
      'RETENTION_IDEMPOTENCY_KEYS_DAYS',
      '6',
      'RETENTION_IDEMPOTENCY_KEYS_DAYS must be an integer in 7..3650',
    ],
  ])('rejects %s=%s', (name, value, message) => {
    expect(problemsOf({ ...minimal, [name]: value })).toEqual([message]);
  });

  it.each(['0', '3601', '1.5', 'abc'])('rejects METRICS_SAMPLE_INTERVAL_SECONDS %j', (value) => {
    expect(problemsOf({ ...minimal, METRICS_SAMPLE_INTERVAL_SECONDS: value })).toEqual([
      'METRICS_SAMPLE_INTERVAL_SECONDS must be an integer in 1..3600',
    ]);
  });

  it('refuses to start without the required settings and lists all of them', () => {
    expect(problemsOf({})).toEqual([
      'PAYMENT_DB_HOST is required',
      'PAYMENT_DB_NAME is required',
      'PAYMENT_DB_USER is required',
      'PAYMENT_DB_PASSWORD is required',
      'WEBHOOK_URL is required',
      'WEBHOOK_SECRET is required',
    ]);
  });

  it('has no default for the secret and treats blank as missing', () => {
    expect(problemsOf({ ...minimal, WEBHOOK_SECRET: '   ' })).toEqual([
      'WEBHOOK_SECRET is required',
    ]);
  });

  it.each(['ftp://x', 'not a url', 'wallet:3001'])('rejects WEBHOOK_URL %j', (url) => {
    expect(problemsOf({ ...minimal, WEBHOOK_URL: url })).toEqual([
      'WEBHOOK_URL must be an absolute http(s) URL',
    ]);
  });

  it.each(['', '1,a', '0', '-1', '1.5', '1,,2'])('rejects WEBHOOK_BACKOFF %j', (value) => {
    const problems = problemsOf({ ...minimal, WEBHOOK_BACKOFF: value });
    // Chuỗi rỗng được coi như không đặt (dùng mặc định).
    expect(problems).toEqual(
      value === ''
        ? []
        : ['WEBHOOK_BACKOFF must be a comma-separated list of positive integers (seconds)'],
    );
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['WORKER_INTERVAL_MS', '0'],
    ['WORKER_INTERVAL_MS', 'abc'],
    ['RESPONSE_TIMEOUT_MS', '-1'],
    ['RESPONSE_TIMEOUT_MS', 'abc'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf({ ...minimal, [name]: value })).toHaveLength(1);
  });

  it('reports a bad database port together with the other problems', () => {
    expect(problemsOf({ ...minimal, PAYMENT_DB_PORT: 'x', WEBHOOK_SECRET: '' })).toEqual([
      'PAYMENT_DB_PORT must be an integer in 1..65535',
      'WEBHOOK_SECRET is required',
    ]);
  });
});
