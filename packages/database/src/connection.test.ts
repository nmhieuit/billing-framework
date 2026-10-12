import type { Dialect } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseConfig } from './config.js';
import { createDatabase } from './connection.js';

const config: DatabaseConfig = {
  host: 'localhost',
  port: 1433,
  database: 'unused',
  user: 'u',
  password: 'p',
};

describe('createDatabase', () => {
  it('builds a database without touching any wrapper when wrapDialect is absent', async () => {
    const db = createDatabase(config);
    await db.destroy();
    expect(db).toBeDefined();
  });

  it('calls wrapDialect exactly once and builds Kysely on the dialect it returns', async () => {
    let createDriverCalls = 0;
    const wrapDialect = vi.fn((inner: Dialect): Dialect => {
      // Dialect của Kysely là lớp (method nằm trên prototype) nên phải ủy quyền tường minh.
      return {
        createDriver: () => {
          createDriverCalls += 1;
          return inner.createDriver();
        },
        createQueryCompiler: () => inner.createQueryCompiler(),
        createAdapter: () => inner.createAdapter(),
        createIntrospector: (db) => inner.createIntrospector(db),
      };
    });

    const db = createDatabase(config, { wrapDialect });
    await db.destroy();

    expect(wrapDialect).toHaveBeenCalledTimes(1);
    const received = wrapDialect.mock.calls[0]?.[0];
    expect(typeof received?.createDriver).toBe('function');
    expect(createDriverCalls).toBe(1);
  });
});
