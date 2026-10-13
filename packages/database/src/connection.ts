import { Kysely, MssqlDialect, type Dialect } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';
import type { DatabaseConfig } from './config.js';

export interface CreateDatabaseOptions {
  /** Chỉ dùng cho test (chaos): bọc dialect MSSQL để chèn lỗi. Không truyền thì hành vi không đổi. */
  wrapDialect?: (dialect: Dialect) => Dialect;
}

export function createDatabase<DB>(
  config: DatabaseConfig,
  options: CreateDatabaseOptions = {},
): Kysely<DB> {
  const dialect = new MssqlDialect({
    tarn: { ...Tarn, options: { min: 0, max: config.poolMax ?? 10 } },
    tedious: {
      ...Tedious,
      connectionFactory: () =>
        new Tedious.Connection({
          server: config.host,
          authentication: {
            type: 'default',
            options: { userName: config.user, password: config.password },
          },
          options: {
            port: config.port,
            database: config.database,
            encrypt: config.encrypt ?? false,
            trustServerCertificate: config.trustServerCertificate ?? true,
          },
        }),
    },
  });
  return new Kysely<DB>({ dialect: options.wrapDialect ? options.wrapDialect(dialect) : dialect });
}
