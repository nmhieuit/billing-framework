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
  WALLET_DB_HOST: 'db',
  WALLET_DB_PASSWORD: 'secret',
  WALLET_TENANTS: 'acme,beta',
  PAYMENT_BASE_URL: 'http://payment:3002',
  PAYMENT_WEBHOOK_SECRET: 'whsec',
  RABBITMQ_HOST: 'mq',
  RABBITMQ_PASSWORD: 'mq-secret',
};

describe('services/wallet/.env.example', () => {
  it('documents exactly the variables the service and the migrate command read', () => {
    expect(Object.keys(example).sort()).toEqual(
      [
        'ORDER_CONSUMER_PREFETCH',
        'ORDER_RETRY_DELAYS',
        'OUTBOX_BATCH',
        'PAYMENT_BASE_URL',
        'PAYMENT_TIMEOUT_MS',
        'PAYMENT_WEBHOOK_SECRET',
        'PORT',
        'RABBITMQ_HOST',
        'RABBITMQ_PASSWORD',
        'RABBITMQ_PORT',
        'RABBITMQ_USER',
        'RABBITMQ_VHOST',
        'TOPUP_SUBMIT_BACKOFF',
        'WALLET_DB_HOST',
        'WALLET_DB_NAME',
        'WALLET_DB_PASSWORD',
        'WALLET_DB_PORT',
        'WALLET_DB_USER',
        'WALLET_MIGRATOR_DB_PASSWORD',
        'WALLET_MIGRATOR_DB_USER',
        'WALLET_TENANTS',
        'WORKER_INTERVAL_MS',
      ].sort(),
    );
  });

  it('is accepted by loadConfig once the blanks are filled in', () => {
    expect(() => loadConfig(filledRequired)).not.toThrow();
  });

  it('shows defaults that equal the defaults in code', () => {
    const onlyRequired = {
      WALLET_DB_HOST: 'db',
      WALLET_DB_NAME: example.WALLET_DB_NAME ?? '',
      WALLET_DB_USER: example.WALLET_DB_USER ?? '',
      WALLET_DB_PASSWORD: 'secret',
      WALLET_TENANTS: 'acme,beta',
      PAYMENT_BASE_URL: 'http://payment:3002',
      PAYMENT_WEBHOOK_SECRET: 'whsec',
      RABBITMQ_HOST: 'mq',
      RABBITMQ_USER: example.RABBITMQ_USER ?? '',
      RABBITMQ_PASSWORD: 'mq-secret',
    };
    expect(loadConfig(filledRequired)).toEqual(loadConfig(onlyRequired));
  });
});
