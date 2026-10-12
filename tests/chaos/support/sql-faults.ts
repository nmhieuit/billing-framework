import { createDatabase, type DatabaseConfig } from '@billing/database';
import {
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
import type { FaultPlan } from './fault-plan.js';

const PROTECTED_DATABASES = new Set(['master', 'tempdb', 'model', 'msdb']);

// KILL mọi session của database config.database (trừ session đang gọi); trả về số session bị giết.
// Chạy bằng kết nối quản trị riêng tới master, không đụng pool của hệ thống đang test.
export async function killSessions(config: DatabaseConfig): Promise<number> {
  const name = config.database.trim();
  if (name === '' || PROTECTED_DATABASES.has(name.toLowerCase())) {
    throw new Error(`killSessions từ chối database "${config.database}"`);
  }
  const admin = createDatabase<unknown>({ ...config, database: 'master', poolMax: 1 });
  try {
    const sessions = await sql<{ session_id: number }>`
      select session_id from sys.dm_exec_sessions
      where database_id = DB_ID(${name}) and session_id <> @@SPID and is_user_process = 1`.execute(
      admin,
    );
    let killed = 0;
    for (const { session_id: id } of sessions.rows) {
      // id là số nguyên lấy từ DMV nên ghép vào KILL là an toàn.
      if (!Number.isInteger(id)) continue;
      try {
        await sql.raw(`kill ${id}`).execute(admin);
        killed += 1;
      } catch {
        // Session có thể đã tự biến mất giữa lúc liệt kê và KILL.
      }
    }
    return killed;
  } finally {
    await admin.destroy();
  }
}

class FaultyConnection implements DatabaseConnection {
  constructor(
    readonly inner: DatabaseConnection,
    private readonly hit: (point: string, sqlText: string) => Promise<void>,
  ) {
    if (inner.cancelQuery) this.cancelQuery = (p) => inner.cancelQuery!(p);
    else delete (this as Partial<FaultyConnection>).cancelQuery;
    if (inner.collectSessionInfo) this.collectSessionInfo = () => inner.collectSessionInfo!();
    else delete (this as Partial<FaultyConnection>).collectSessionInfo;
    if (inner.killSession) this.killSession = (p) => inner.killSession!(p);
    else delete (this as Partial<FaultyConnection>).killSession;
  }

  async executeQuery<R>(
    compiledQuery: CompiledQuery,
    options?: Parameters<DatabaseConnection['executeQuery']>[1],
  ): Promise<QueryResult<R>> {
    const text = compiledQuery.sql.toLowerCase();
    await this.hit('sql.query.before', text);
    const result = await this.inner.executeQuery<R>(compiledQuery, options);
    await this.hit('sql.query.after', text);
    return result;
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: Parameters<DatabaseConnection['streamQuery']>[2],
  ): AsyncIterableIterator<QueryResult<R>> {
    await this.hit('sql.query.before', compiledQuery.sql.toLowerCase());
    yield* this.inner.streamQuery<R>(compiledQuery, chunkSize, options);
  }

  // Các phương thức tuỳ chọn của DatabaseConnection (huỷ/kill) chỉ có khi kết nối thật có; chuyển tiếp nguyên vẹn.
  cancelQuery!: NonNullable<DatabaseConnection['cancelQuery']>;
  collectSessionInfo!: NonNullable<DatabaseConnection['collectSessionInfo']>;
  killSession!: NonNullable<DatabaseConnection['killSession']>;
}

// Dialect bọc: gọi plan.hit(point, { sql, name }) quanh mỗi lệnh/transaction của kết nối.
export function faultyDialect(
  plan: FaultPlan,
  options: { name?: string } = {},
): (dialect: Dialect) => Dialect {
  return (dialect) => ({
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db) => dialect.createIntrospector(db),
    createDriver: (): Driver => {
      const inner = dialect.createDriver();
      const hit = (point: string, sqlText: string): Promise<void> =>
        plan.hit(point, { sql: sqlText, name: options.name });
      const raw = (c: DatabaseConnection): DatabaseConnection =>
        c instanceof FaultyConnection ? c.inner : c;
      const driver: Driver = {
        init: (o) => inner.init(o),
        acquireConnection: async (o) => new FaultyConnection(await inner.acquireConnection(o), hit),
        beginTransaction: async (c: DatabaseConnection, s: TransactionSettings) => {
          await inner.beginTransaction(raw(c), s);
          await hit('sql.begin.after', 'begin transaction');
        },
        commitTransaction: async (c) => {
          await hit('sql.commit.before', 'commit');
          await inner.commitTransaction(raw(c));
          await hit('sql.commit.after', 'commit');
        },
        rollbackTransaction: async (c) => {
          await hit('sql.rollback.before', 'rollback');
          await inner.rollbackTransaction(raw(c));
        },
        releaseConnection: (c, o) => inner.releaseConnection(raw(c), o),
        destroy: (o) => inner.destroy(o),
      };
      if (inner.savepoint) {
        const sp = inner.savepoint.bind(inner);
        driver.savepoint = (c, n, q) => sp(raw(c), n, q);
      }
      if (inner.rollbackToSavepoint) {
        const rb = inner.rollbackToSavepoint.bind(inner);
        driver.rollbackToSavepoint = (c, n, q) => rb(raw(c), n, q);
      }
      if (inner.releaseSavepoint) {
        const rl = inner.releaseSavepoint.bind(inner);
        driver.releaseSavepoint = (c, n, q) => rl(raw(c), n, q);
      }
      return driver;
    },
  });
}
