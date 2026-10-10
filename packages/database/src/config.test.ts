import { describe, expect, it } from 'vitest';
import { ConfigError, databaseConfigFromEnv, migratorConfigFromEnv } from './config.js';

const full = {
  PAYMENT_DB_HOST: 'db',
  PAYMENT_DB_NAME: 'billing_payment',
  PAYMENT_DB_USER: 'u',
  PAYMENT_DB_PASSWORD: 'p',
};

describe('databaseConfigFromEnv', () => {
  it('reads values and defaults the port to 1433', () => {
    expect(databaseConfigFromEnv('PAYMENT_DB', full)).toEqual({
      host: 'db',
      port: 1433,
      database: 'billing_payment',
      user: 'u',
      password: 'p',
    });
  });

  it('uses an explicit port', () => {
    expect(databaseConfigFromEnv('PAYMENT_DB', { ...full, PAYMENT_DB_PORT: '14333' }).port).toBe(
      14333,
    );
  });

  it('lists every missing variable at once', () => {
    try {
      databaseConfigFromEnv('PAYMENT_DB', {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        'PAYMENT_DB_HOST is required',
        'PAYMENT_DB_NAME is required',
        'PAYMENT_DB_USER is required',
        'PAYMENT_DB_PASSWORD is required',
      ]);
    }
  });

  it.each(['abc', '0', '70000', '1.5'])('rejects invalid port %s', (port) => {
    expect(() => databaseConfigFromEnv('PAYMENT_DB', { ...full, PAYMENT_DB_PORT: port })).toThrow(
      ConfigError,
    );
  });

  it('treats blank values as missing', () => {
    expect(() =>
      databaseConfigFromEnv('PAYMENT_DB', { ...full, PAYMENT_DB_PASSWORD: '  ' }),
    ).toThrow(ConfigError);
  });
});

describe('migratorConfigFromEnv', () => {
  const app = {
    WALLET_DB_HOST: 'db',
    WALLET_DB_PORT: '14333',
    WALLET_DB_NAME: 'billing_wallet',
    WALLET_DB_USER: 'app',
    WALLET_DB_PASSWORD: 'app-secret',
  };
  const migrator = (env: NodeJS.ProcessEnv) =>
    migratorConfigFromEnv('WALLET_DB', 'WALLET_MIGRATOR_DB', env);

  it('uses the application account when no migrator account is set', () => {
    expect(migrator(app)).toEqual({
      host: 'db',
      port: 14333,
      database: 'billing_wallet',
      user: 'app',
      password: 'app-secret',
    });
  });

  it('swaps in the migrator account and keeps host, port and database', () => {
    expect(
      migrator({
        ...app,
        WALLET_MIGRATOR_DB_USER: 'owner',
        WALLET_MIGRATOR_DB_PASSWORD: 'owner-secret',
      }),
    ).toEqual({
      host: 'db',
      port: 14333,
      database: 'billing_wallet',
      user: 'owner',
      password: 'owner-secret',
    });
  });

  it('treats blank migrator values (an untouched .env.example) as not set', () => {
    expect(
      migrator({ ...app, WALLET_MIGRATOR_DB_USER: '', WALLET_MIGRATOR_DB_PASSWORD: '  ' }).user,
    ).toBe('app');
  });

  it.each([
    [{ WALLET_MIGRATOR_DB_USER: 'owner' }],
    [{ WALLET_MIGRATOR_DB_PASSWORD: 'owner-secret' }],
    [{ WALLET_MIGRATOR_DB_USER: 'owner', WALLET_MIGRATOR_DB_PASSWORD: '' }],
  ])('refuses a half-set migrator account %j', (extra) => {
    try {
      migrator({ ...app, ...extra });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        'WALLET_MIGRATOR_DB_USER and WALLET_MIGRATOR_DB_PASSWORD must be set together',
      ]);
    }
  });

  it('still reports missing application variables', () => {
    expect(() => migrator({})).toThrow(ConfigError);
  });
});
