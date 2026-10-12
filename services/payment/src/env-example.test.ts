import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const text = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const example = Object.fromEntries(
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)] as const;
    }),
);

const filledRequired = {
  ...example,
  PAYMENT_DB_HOST: 'db',
  PAYMENT_DB_PASSWORD: 'secret',
  WEBHOOK_URL: 'http://wallet:3001/webhooks/payment',
  WEBHOOK_SECRET: 'whsec',
};

describe('services/payment/.env.example', () => {
  it('documents exactly the variables the service and the migrate command read', () => {
    expect(Object.keys(example).sort()).toEqual(
      [
        'METRICS_SAMPLE_INTERVAL_SECONDS',
        'PAYMENT_DB_HOST',
        'PAYMENT_DB_NAME',
        'PAYMENT_DB_PASSWORD',
        'PAYMENT_DB_PORT',
        'PAYMENT_DB_USER',
        'PAYMENT_MIGRATOR_DB_PASSWORD',
        'PAYMENT_MIGRATOR_DB_USER',
        'PORT',
        'RESPONSE_TIMEOUT_MS',
        'RETENTION_BATCH_SIZE',
        'RETENTION_DRY_RUN',
        'RETENTION_ENABLED',
        'RETENTION_IDEMPOTENCY_KEYS_DAYS',
        'RETENTION_INTERVAL_MINUTES',
        'RETENTION_MAX_SECONDS_PER_RUN',
        'RETENTION_WEBHOOK_DAYS',
        'WEBHOOK_BACKOFF',
        'WEBHOOK_SECRET',
        'WEBHOOK_URL',
        'WORKER_INTERVAL_MS',
      ].sort(),
    );
  });

  it('is accepted by loadConfig once the blanks are filled in', () => {
    expect(() => loadConfig(filledRequired)).not.toThrow();
  });

  it('shows defaults that equal the defaults in code', () => {
    const onlyRequired = {
      PAYMENT_DB_HOST: 'db',
      PAYMENT_DB_NAME: example.PAYMENT_DB_NAME ?? '',
      PAYMENT_DB_USER: example.PAYMENT_DB_USER ?? '',
      PAYMENT_DB_PASSWORD: 'secret',
      WEBHOOK_URL: 'http://wallet:3001/webhooks/payment',
      WEBHOOK_SECRET: 'whsec',
    };
    expect(loadConfig(filledRequired)).toEqual(loadConfig(onlyRequired));
    expect(loadConfig(onlyRequired).retention).toMatchObject({
      enabled: true,
      dryRun: true,
      intervalMinutes: 60,
      maxSecondsPerRun: 60,
      batchSize: 1000,
    });
  });
});
