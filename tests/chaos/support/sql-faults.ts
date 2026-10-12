import { createDatabase, type DatabaseConfig } from '@billing/database';
import {
  sql,
  type Kysely,
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
    return await killSessionIds(
      admin,
      sessions.rows.map((r) => r.session_id),
    );
  } finally {
    await admin.destroy();
  }
}

// 6106: không phải process đang hoạt động (session đã tự biến mất); 6104: không thể KILL chính mình.
const BENIGN_KILL_ERRORS = new Set([6106, 6104]);

function sqlErrorNumber(error: unknown): number | undefined {
  for (let e = error as { number?: unknown; cause?: unknown } | undefined, i = 0; e && i < 4; i++) {
    if (typeof e.number === 'number') return e.number;
    e = e.cause as typeof e;
  }
  return undefined;
}

// KILL từng session id (số nguyên); chỉ bỏ qua lỗi 6106/6104, mọi lỗi khác được ném lại.
export async function killSessionIds(admin: Kysely<unknown>, ids: number[]): Promise<number> {
  let killed = 0;
  for (const id of ids) {
    if (!Number.isInteger(id)) throw new Error(`session id không hợp lệ: ${String(id)}`);
    try {
      // id là số nguyên đã kiểm tra nên ghép vào KILL là an toàn.
      await sql.raw(`kill ${id}`).execute(admin);
      killed += 1;
    } catch (error) {
      const n = sqlErrorNumber(error);
      if (n === undefined || !BENIGN_KILL_ERRORS.has(n)) throw error;
    }
  }
  return killed;
}

// Mã tăng dần cho mỗi kết nối vật lý được bọc; info.connection cho rule phân biệt các transaction đồng thời.
let nextConnectionId = 1;

class FaultyConnection implements DatabaseConnection {
  readonly id = nextConnectionId++;

  constructor(
    readonly inner: DatabaseConnection,
    private readonly hit: (point: string, sqlText: string, connection: number) => Promise<void>,
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
    await this.hit('sql.query.before', text, this.id);
    const result = await this.inner.executeQuery<R>(compiledQuery, options);
    await this.hit('sql.query.after', text, this.id);
    return result;
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: Parameters<DatabaseConnection['streamQuery']>[2],
  ): AsyncIterableIterator<QueryResult<R>> {
    // Có chủ đích: streamQuery chỉ phát 'sql.query.before', không có 'sql.query.after'.
    await this.hit('sql.query.before', compiledQuery.sql.toLowerCase(), this.id);
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
      const hit = (point: string, sqlText: string, connection: number): Promise<void> =>
        plan.hit(point, { sql: sqlText, name: options.name, connection });
      const raw = (c: DatabaseConnection): DatabaseConnection =>
        c instanceof FaultyConnection ? c.inner : c;
      const idOf = (c: DatabaseConnection): number => (c instanceof FaultyConnection ? c.id : 0);
      const driver: Driver = {
        init: (o) => inner.init(o),
        acquireConnection: async (o) => new FaultyConnection(await inner.acquireConnection(o), hit),
        beginTransaction: async (c: DatabaseConnection, s: TransactionSettings) => {
          await inner.beginTransaction(raw(c), s);
          await hit('sql.begin.after', 'begin transaction', idOf(c));
        },
        commitTransaction: async (c) => {
          await hit('sql.commit.before', 'commit', idOf(c));
          await inner.commitTransaction(raw(c));
          await hit('sql.commit.after', 'commit', idOf(c));
        },
        rollbackTransaction: async (c) => {
          await hit('sql.rollback.before', 'rollback', idOf(c));
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
