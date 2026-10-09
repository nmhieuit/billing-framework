import { Kysely, MssqlDialect } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';
import type { DatabaseConfig } from './config.js';

export function createDatabase<DB>(config: DatabaseConfig): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new MssqlDialect({
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
    }),
  });
}
