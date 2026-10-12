import { createDatabase } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { FaultPlan } from './fault-plan.js';
import { OpLog } from './op-log.js';
import { faultyDialect, killSessionIds, killSessions } from './sql-faults.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newDb(wrap?: ReturnType<typeof faultyDialect>): Promise<{
  testDb: TestDatabase;
  db: Kysely<unknown>;
}> {
  const testDb = await createTestDatabase('chaos_sql');
  cleanups.push(() => testDb.drop());
  const db = createDatabase<unknown>(
    testDb.config,
    wrap === undefined ? {} : { wrapDialect: wrap },
  );
  cleanups.push(() => db.destroy());
  await sql`create table t (id int primary key, v nvarchar(50) not null)`.execute(db);
  return { testDb, db };
}

// Đọc bằng kết nối mới (pool riêng) để chắc chắn thấy dữ liệu đã commit thật sự.
async function countRows(testDb: TestDatabase): Promise<number[]> {
  const fresh = createDatabase<unknown>({ ...testDb.config, poolMax: 1 });
  try {
    const r = await sql<{ id: number }>`select id from t order by id`.execute(fresh);
    return r.rows.map((x) => x.id);
  } finally {
    await fresh.destroy();
  }
}

const isInsert = (info: Record<string, unknown>): boolean =>
  typeof info.sql === 'string' && info.sql.includes('insert into');

describe('killSessions', () => {
  it('giết đúng session của pool và pool hồi phục (bằng chứng INV-8)', async () => {
    const { testDb, db } = await newDb();
    const admin = createDatabase<unknown>({ ...testDb.config, database: 'master', poolMax: 1 });
    cleanups.push(() => admin.destroy());
    const spids = new Set<number>();
    // Giữ đồng thời nhiều kết nối để pool mở nhiều session riêng biệt.
    await Promise.all(
      [1, 2, 3].map(() =>
        db.connection().execute(async (c) => {
          const r = await sql<{ spid: number }>`select @@SPID as spid`.execute(c);
          spids.add(r.rows[0]?.spid ?? -1);
          await sql`waitfor delay '00:00:00.300'`.execute(c);
        }),
      ),
    );
    expect(spids.size).toBeGreaterThanOrEqual(2);

    const killed = await killSessions(testDb.config);
    expect(killed).toBeGreaterThanOrEqual(spids.size);

    const alive = await sql<{ session_id: number }>`
      select session_id from sys.dm_exec_sessions where database_id = DB_ID(${testDb.config.database})`.execute(
      admin,
    );
    for (const row of alive.rows) expect(spids.has(row.session_id)).toBe(false);

    let failures = 0;
    let ok = false;
    for (let i = 0; i < 10 && !ok; i += 1) {
      try {
        await sql`insert into t (id, v) values (${i + 1}, 'x')`.execute(db);
        ok = true;
      } catch {
        failures += 1;
      }
    }
    // tarn validate-on-acquire (select 1) thay kết nối chết nên quan sát được là 0 lệnh lỗi.
    expect(ok).toBe(true);
    expect(failures).toBe(0);
  });

  it('không giết session của database khác nhưng giết session của database đích (kết nối ghim)', async () => {
    const first = await createTestDatabase('chaos_sql');
    cleanups.push(() => first.drop());
    const second = await createTestDatabase('chaos_sql');
    cleanups.push(() => second.drop());
    const dbA = createDatabase<unknown>(first.config);
    cleanups.push(() => dbA.destroy());
    const dbB = createDatabase<unknown>(second.config);
    cleanups.push(() => dbB.destroy());

    // Kết nối ghim không được pool kiểm tra lại, nên bị giết nhầm sẽ làm test hỏng.
    await dbA.connection().execute(async (cA) => {
      await dbB.connection().execute(async (cB) => {
        const before = await sql<{ spid: number }>`select @@SPID as spid`.execute(cB);
        await sql`select @@SPID as spid`.execute(cA);

        const killed = await killSessions(first.config);
        expect(killed).toBeGreaterThanOrEqual(1);

        const after = await sql<{ spid: number }>`select @@SPID as spid`.execute(cB);
        expect(after.rows[0]?.spid).toBe(before.rows[0]?.spid);
        await expect(sql`select 1 as one`.execute(cA)).rejects.toThrow();
      });
    });
  });

  it.each(['master', 'tempdb', 'model', 'msdb', ''])('từ chối database "%s"', async (database) => {
    const config = { host: 'localhost', port: 1, user: 'x', password: 'x', database };
    await expect(killSessions(config)).rejects.toThrow(/từ chối/);
  });

  it('killSessionIds: bỏ qua 6106/6104, ném lại lỗi khác', async () => {
    const testDb = await createTestDatabase('chaos_sql');
    cleanups.push(() => testDb.drop());
    const admin = createDatabase<unknown>({ ...testDb.config, database: 'master', poolMax: 1 });
    cleanups.push(() => admin.destroy());
    const self = await sql<{ spid: number }>`select @@SPID as spid`.execute(admin);

    expect(await killSessionIds(admin, [32000])).toBe(0); // 6106: không tồn tại
    expect(await killSessionIds(admin, [self.rows[0]?.spid ?? -1])).toBe(0); // 6104: chính mình
    await expect(killSessionIds(admin, [1])).rejects.toThrow(); // session hệ thống: lỗi khác, phải ném
    await expect(killSessionIds(admin, [1.5])).rejects.toThrow();
  });
});

describe('faultyDialect', () => {
  it('kill ở sql.query.before (insert thứ 2) làm transaction rollback toàn bộ', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { testDb, db } = await newDb(faultyDialect(plan, { name: 'wallet' }));
    let killed = 0;
    plan.add({
      point: 'sql.query.before',
      when: isInsert,
      nth: 2,
      label: 'kill-mid-tx',
      action: async () => {
        killed = await killSessions(testDb.config);
      },
    });

    await expect(
      db.transaction().execute(async (trx) => {
        await sql`insert into t (id, v) values (1, 'a')`.execute(trx);
        await sql`insert into t (id, v) values (2, 'b')`.execute(trx);
      }),
    ).rejects.toThrow();

    expect(plan.fired('kill-mid-tx')).toBe(1);
    expect(killed).toBeGreaterThan(0);
    expect(await countRows(testDb)).toEqual([]);
  });

  it('kill ở sql.commit.after: dữ liệu đã commit vẫn còn', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { testDb, db } = await newDb(faultyDialect(plan, { name: 'payment' }));
    let killed = 0;
    plan.add({
      point: 'sql.commit.after',
      label: 'kill-after-commit',
      action: async () => {
        killed = await killSessions(testDb.config);
      },
    });

    await db
      .transaction()
      .execute(async (trx) => {
        await sql`insert into t (id, v) values (1, 'a')`.execute(trx);
      })
      .catch(() => undefined); // Phía gọi có thể nhận lỗi hoặc không; dữ liệu mới là thứ cần kiểm.

    expect(plan.fired('kill-after-commit')).toBe(1);
    expect(killed).toBeGreaterThan(0);
    expect(await countRows(testDb)).toEqual([1]);
  });

  it('không có rule nào kích hoạt thì hành vi như không bọc', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { testDb, db } = await newDb(faultyDialect(plan));

    await sql`insert into t (id, v) values (1, 'a')`.execute(db);
    await db.transaction().execute(async (trx) => {
      await sql`insert into t (id, v) values (2, 'b')`.execute(trx);
    });
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`insert into t (id, v) values (3, 'c')`.execute(trx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const r = await sql<{ id: number }>`select id from t order by id`.execute(db);

    expect(r.rows.map((x) => x.id)).toEqual([1, 2]);
    expect(await countRows(testDb)).toEqual([1, 2]);
    expect(plan.hits('sql.begin.after')).toBe(2);
    expect(plan.hits('sql.commit.before')).toBe(1);
    expect(plan.hits('sql.commit.after')).toBe(1);
    expect(plan.hits('sql.rollback.before')).toBe(1);
  });

  it('truyền info.name và info.sql đúng', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { db } = await newDb(faultyDialect(plan, { name: 'wallet' }));
    const seen: Array<Record<string, unknown>> = [];
    plan.add({
      point: 'sql.query.before',
      action: (info) => {
        seen.push(info);
      },
    });

    await sql`SELECT 42 AS Answer`.execute(db);

    const last = seen.at(-1);
    expect(last?.name).toBe('wallet');
    expect(last?.sql).toBe('select 42 as answer');
  });

  it('rule ném lỗi giả ở sql.query.before được lan ra phía gọi', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { db } = await newDb(faultyDialect(plan));
    plan.add({
      point: 'sql.query.before',
      when: isInsert,
      times: 1,
      action: () => {
        throw new Error('connection lost');
      },
    });

    await expect(sql`insert into t (id, v) values (1, 'a')`.execute(db)).rejects.toThrow(
      'connection lost',
    );
    await sql`insert into t (id, v) values (1, 'a')`.execute(db);
  });
});
