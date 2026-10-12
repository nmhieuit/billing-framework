import { createDatabase } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { FaultPlan } from './fault-plan.js';
import { OpLog } from './op-log.js';
import { faultyDialect, killSessions } from './sql-faults.js';

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
  it('pool hồi phục sau khi session nhàn rỗi bị giết (bằng chứng INV-8)', async () => {
    const { testDb, db } = await newDb();
    await Promise.all([1, 2, 3].map(() => sql`select 1 as one`.execute(db)));
    const killed = await killSessions(testDb.config);
    expect(killed).toBeGreaterThanOrEqual(1);

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
    // Ghi lại hành vi quan sát được: số lệnh lỗi trước khi pool tự hồi phục.
    console.info(`[INV-8] lệnh lỗi trước khi pool hồi phục: ${failures}`);
    expect(ok).toBe(true);
    const r = await sql<{ n: number }>`select count(*) as n from t`.execute(db);
    expect(r.rows[0]?.n).toBe(1);
  });

  it('không ảnh hưởng database khác', async () => {
    const first = await createTestDatabase('chaos_sql');
    cleanups.push(() => first.drop());
    const second = await createTestDatabase('chaos_sql');
    cleanups.push(() => second.drop());
    const dbA = createDatabase<unknown>(first.config);
    cleanups.push(() => dbA.destroy());
    const dbB = createDatabase<unknown>(second.config);
    cleanups.push(() => dbB.destroy());
    await sql`select 1 as one`.execute(dbA);
    await sql`select 1 as one`.execute(dbB);

    await killSessions(first.config);

    const r = await sql<{ one: number }>`select 1 as one`.execute(dbB);
    expect(r.rows[0]?.one).toBe(1);
  });

  it.each(['master', 'tempdb', 'model', 'msdb', ''])('từ chối database "%s"', async (database) => {
    const testDb = await createTestDatabase('chaos_sql');
    cleanups.push(() => testDb.drop());
    await expect(killSessions({ ...testDb.config, database })).rejects.toThrow();
  });
});

describe('faultyDialect', () => {
  it('kill ở sql.query.before (insert thứ 2) làm transaction rollback toàn bộ', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { testDb, db } = await newDb(faultyDialect(plan, { name: 'wallet' }));
    plan.add({
      point: 'sql.query.before',
      when: isInsert,
      nth: 2,
      label: 'kill-mid-tx',
      action: async () => {
        await killSessions(testDb.config);
      },
    });

    await expect(
      db.transaction().execute(async (trx) => {
        await sql`insert into t (id, v) values (1, 'a')`.execute(trx);
        await sql`insert into t (id, v) values (2, 'b')`.execute(trx);
      }),
    ).rejects.toThrow();

    expect(plan.fired('kill-mid-tx')).toBe(1);
    expect(await countRows(testDb)).toEqual([]);
  });

  it('kill ở sql.commit.after: dữ liệu đã commit vẫn còn', async () => {
    const plan = new FaultPlan({ log: new OpLog() });
    const { testDb, db } = await newDb(faultyDialect(plan, { name: 'payment' }));
    plan.add({
      point: 'sql.commit.after',
      label: 'kill-after-commit',
      action: async () => {
        await killSessions(testDb.config);
      },
    });

    await db
      .transaction()
      .execute(async (trx) => {
        await sql`insert into t (id, v) values (1, 'a')`.execute(trx);
      })
      .catch(() => undefined); // Phía gọi có thể nhận lỗi hoặc không; dữ liệu mới là thứ cần kiểm.

    expect(plan.fired('kill-after-commit')).toBe(1);
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

    await sql`select 42 as answer`.execute(db);

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
