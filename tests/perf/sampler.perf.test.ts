import { createDatabase } from '@billing/database';
import { createTestDatabase } from '@billing/testing';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockedSampler } from './support/wait-stats.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// Kiểm BlockedSampler trên SQL Server thật với câu lệnh NHIỀU tham số (Kysely/tedious gửi qua sp_executesql, văn bản
// dm_exec_sql_text bắt đầu bằng khai báo tham số dài hơn 120 ký tự) và batch NHIỀU câu lệnh (chỉ câu đang bị chặn
// mới được lấy, nhờ statement_start_offset/statement_end_offset). Cũng kiểm wait_resource được ghi theo nhóm.
// Đã kiểm bằng cách chạy lặp lại bằng tay (test không tự lặp).
describe('BlockedSampler on real SQL Server', () => {
  it('lấy đúng câu lệnh đang bị chặn (bỏ khai báo tham số, bỏ câu lệnh khác trong batch) kèm wait_resource', async () => {
    const testDb = await createTestDatabase('perf_sampler');
    cleanups.push(() => testDb.drop());
    const load = createDatabase<unknown>({ ...testDb.config, poolMax: 4 });
    cleanups.push(() => load.destroy());
    const holder = createDatabase<unknown>({ ...testDb.config, poolMax: 1 });
    cleanups.push(() => holder.destroy());
    const admin = createDatabase<unknown>({ ...testDb.config, database: 'master', poolMax: 2 });
    cleanups.push(() => admin.destroy());

    await sql`create table wide (id int primary key,
      c1 nvarchar(50) not null, c2 nvarchar(50) not null, c3 nvarchar(50) not null, c4 nvarchar(50) not null,
      c5 nvarchar(50) not null, c6 nvarchar(50) not null, c7 nvarchar(50) not null, c8 nvarchar(50) not null)`.execute(
      load,
    );
    await sql`insert into wide values (1, 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a')`.execute(load);

    const sampler = new BlockedSampler(admin, {
      intervalMs: 50,
      databaseName: testDb.config.database,
    });
    sampler.start();
    // Đăng ký dừng ngay để một lượt hỏng không để sampler rò sang pool đã hủy.
    cleanups.push(async () => {
      await sampler.stop();
    });

    let held!: () => void;
    const heldPromise = new Promise<void>((resolve) => (held = resolve));
    const rollbackSentinel = new Error('rollback sampler hold');
    const holdTask = holder
      .transaction()
      .execute(async (trx) => {
        await sql`update wide set c1 = 'h' where id = 1`.execute(trx);
        held();
        await sleep(1200);
        throw rollbackSentinel;
      })
      .catch((error: unknown) => {
        if (error !== rollbackSentinel) throw error;
      });
    await heldPromise;

    // 8 cột ràng buộc + id = 9 tham số: khai báo "(@1 nvarchar(4000),...)" dài hơn nhiều so với 120 ký tự.
    const manyParams = sql`update wide set c1 = ${'1'}, c2 = ${'2'}, c3 = ${'3'}, c4 = ${'4'},
      c5 = ${'5'}, c6 = ${'6'}, c7 = ${'7'}, c8 = ${'8'} where id = ${1}`.execute(load);
    // Batch hai câu lệnh: câu đầu xong ngay, câu thứ hai bị chặn.
    const multiStatement =
      sql`select 1 as one; update wide set c4 = ${'m'} where id = ${1}`.execute(load);
    await Promise.all([manyParams, multiStatement, holdTask]);
    const summary = await sampler.stop();
    console.log(`[sampler] ${JSON.stringify(summary)}`);

    expect(sampler.errorCount, `sampler lỗi: ${sampler.lastError}`).toBe(0);
    const lck = summary.filter((s) => s.waitType.startsWith('LCK_M_'));
    const many = lck.find((s) => s.statement.startsWith('update wide set c1 = @1'));
    expect(many, 'thiếu nhóm câu lệnh nhiều tham số').toBeDefined();
    expect(many?.statement).not.toMatch(/nvarchar\(4000\)/); // khai báo tham số đã bị bỏ
    expect(many?.statement).toContain('c8 = @8'); // vẫn thấy tới cột cuối (không bị cụt bởi khai báo)
    const multi = lck.find((s) => s.statement.startsWith('update wide set c4 = @1'));
    expect(multi, 'thiếu nhóm câu lệnh trong batch nhiều câu').toBeDefined();
    expect(multi?.statement).not.toContain('select 1'); // chỉ câu lệnh đang bị chặn
    expect(many?.resources?.[0]?.resource).toMatch(/^(KEY|RID):/);
    expect(many?.resources?.[0]?.count).toBeGreaterThan(0);
  });
});
