import { describe, expect, it } from 'vitest';
import { ConfigError, databaseConfigFromEnv } from './config.js';

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
