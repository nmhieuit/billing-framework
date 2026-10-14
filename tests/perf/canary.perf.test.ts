import { createDatabase } from '@billing/database';
import { createTestDatabase } from '@billing/testing';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { runClosedLoop } from './support/load-driver.js';
import { BlockedSampler, diffWaits, snapshotWaits } from './support/wait-stats.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const WORKERS = 8;
const WARMUP_MS = 500;
const DURATION_MS = 3000;
// Giữ khóa bắt đầu sau ~1 s kể từ lúc chạy và kéo dài ~1,5 s → nằm trọn trong cửa sổ đo [0,5 s ; 3,5 s].
const HOLD_START_MS = 1000;
const HOLD_MS = 1500;

// Canary tranh chấp khóa: chứng minh bộ đo THẤY được khóa bị giữ.
//
// Thiết kế: bảng hot có 8 dòng, MỖI WORKER cập nhật dòng RIÊNG của mình (id = worker + 1) nên control gần như không
// có tranh chấp khóa (nếu 8 worker dồn vào 1 dòng thì control tự nó đã bão hòa chờ khóa, ~7 worker luôn chờ, tổng
// LCK_M_* waitMs ≈ 7 × thời gian chạy ở cả control lẫn hold và không phân biệt được; đã đo thực tế). Ở hold, một kết
// nối riêng mở transaction `update hot set v = v + 1` (không where → giữ khóa X mọi dòng) trong ~1,5 s rồi rollback,
// nên cả 8 worker đều bị chặn.
//
// Mọi ngưỡng là TƯƠNG ĐỐI trong cùng một lượt chạy (cùng máy, cùng DB, control ngay trước hold), đủ rộng và không
// phụ thuộc tốc độ máy. Không so thông lượng giữa HAI lượt (tốc độ máy dao động tới ~2× giữa hai lượt liên tiếp,
// đã đo, nên ngưỡng kiểu 0,8 × control vừa có thể flake vừa không phân biệt được hold 0 ms); thay vào đó so
// thông lượng TRONG chính lượt hold: trong khoảng đang giữ khóa gần như không thao tác nào hoàn tất.
//  (a) số thao tác hoàn tất trong khoảng giữ khóa <= 10% số kỳ vọng theo tốc độ ngoài khoảng giữ của chính lượt đó;
//  (b) tổng LCK_M_* waitMs (sys.dm_os_wait_stats) của hold > 500 ms VÀ > 10 × control;
//  (b') độ trễ lớn nhất của hold >= HOLD_MS / 2 (thao tác đang bay lúc bị giữ khóa không thể xong sớm hơn);
//  (c) sampler thấy ít nhất một request bị chặn LCK_M_* trên câu lệnh update hot (SQL Server tự tham số hóa đơn
//      giản nên văn bản có thể là "(@1 int)update [hot] set [v] = [v]+@1 ...", vì vậy khớp cả dạng có ngoặc vuông).
// Nếu giữ khóa 0 ms (đột biến), (b), (b') và (c) đều sai.
describe('contention canary', () => {
  it('thấy rõ khóa bị giữ: ngừng hoàn tất, LCK_M_* tăng, sampler thấy request bị chặn', async () => {
    const testDb = await createTestDatabase('perf_canary');
    cleanups.push(() => testDb.drop());
    // Pool tải: đủ chỗ cho mọi worker. Mọi kết nối phụ (admin, holder) là pool riêng, không tranh chỗ với tải.
    const load = createDatabase<unknown>({ ...testDb.config, poolMax: WORKERS });
    cleanups.push(() => load.destroy());
    const holder = createDatabase<unknown>({ ...testDb.config, poolMax: 1 });
    cleanups.push(() => holder.destroy());
    const admin = createDatabase<unknown>({ ...testDb.config, database: 'master', poolMax: 2 });
    cleanups.push(() => admin.destroy());

    await sql`create table hot (id int primary key, v int not null)`.execute(load);
    await sql`insert into hot (id, v) values (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (7, 0), (8, 0)`.execute(
      load,
    );

    // Mốc thời gian (performance.now) mỗi thao tác hoàn tất, để đếm thao tác theo từng khoảng bên trong một lượt.
    const run = (): Promise<{
      result: Awaited<ReturnType<typeof runClosedLoop>>;
      completions: number[];
    }> => {
      const completions: number[] = [];
      return runClosedLoop({
        concurrency: WORKERS,
        durationMs: DURATION_MS,
        warmupMs: WARMUP_MS,
        task: async ({ worker }) => {
          await sql`update hot set v = v + 1 where id = ${worker + 1}`.execute(load);
          completions.push(performance.now());
        },
      }).then((result) => ({ result, completions }));
    };

    const totalWaitMs = (diff: Record<string, { waitMs: number }>): number =>
      Object.values(diff).reduce((sum, w) => sum + w.waitMs, 0);

    // Khởi động pool trước để chi phí mở kết nối không lọt vào control.
    await Promise.all(Array.from({ length: WORKERS }, () => sql`select 1 as one`.execute(load)));

    // Control: không giữ khóa.
    const controlBefore = await snapshotWaits(admin);
    const { result: control } = await run();
    const controlWaits = diffWaits(controlBefore, await snapshotWaits(admin));

    // Hold: một kết nối riêng mở transaction giữ khóa mọi dòng trong HOLD_MS rồi rollback, song song với lượt chạy.
    const holdBefore = await snapshotWaits(admin);
    const sampler = new BlockedSampler(admin, {
      intervalMs: 100,
      databaseName: testDb.config.database,
    });
    sampler.start();
    let heldFrom = 0;
    let heldUntil = 0;
    const holdTask = (async (): Promise<void> => {
      await sleep(HOLD_START_MS);
      // Transaction của Kysely (BEGIN/ROLLBACK qua API tedious; câu `begin transaction` thô không dùng được
      // với sp_executesql). Ném sentinel để ép rollback sau khi giữ khóa đủ HOLD_MS.
      const rollbackSentinel = new Error('rollback canary hold');
      await holder
        .transaction()
        .execute(async (trx) => {
          await sql`update hot set v = v + 1`.execute(trx);
          heldFrom = performance.now();
          await sleep(HOLD_MS);
          heldUntil = performance.now();
          throw rollbackSentinel;
        })
        .catch((error: unknown) => {
          if (error !== rollbackSentinel) throw error;
        });
    })();
    const { result: hold, completions } = await run();
    await holdTask;
    const blocked = await sampler.stop();
    const holdWaits = diffWaits(holdBefore, await snapshotWaits(admin));

    const controlWait = totalWaitMs(controlWaits);
    const holdWait = totalWaitMs(holdWaits);
    // Cửa sổ chặn: bỏ 200 ms đầu (thao tác đang bay lúc khóa vừa được giữ có thể vừa kịp xong).
    const insideHold = completions.filter((t) => t > heldFrom + 200 && t < heldUntil).length;
    const outsideHold = completions.filter((t) => t <= heldFrom || t >= heldUntil).length;
    const outsideMs = Math.max(1, DURATION_MS + WARMUP_MS - (heldUntil - heldFrom));
    const expectedInside = (outsideHold / outsideMs) * (heldUntil - heldFrom - 200);
    console.log(
      `[canary] control: ${control.throughputPerSec.toFixed(0)} ops/s (ok=${control.ok}, errors=${JSON.stringify(control.errors)}), LCK waitMs=${controlWait.toFixed(0)}; ` +
        `hold: ${hold.throughputPerSec.toFixed(0)} ops/s (ok=${hold.ok}, errors=${JSON.stringify(hold.errors)}), LCK waitMs=${holdWait.toFixed(0)}; ` +
        `cross-run ratio=${(hold.throughputPerSec / control.throughputPerSec).toFixed(2)} (chỉ để tham khảo); ` +
        `held=${(heldUntil - heldFrom).toFixed(0)}ms, completed inside hold=${insideHold} vs expected-without-hold=${expectedInside.toFixed(0)}; ` +
        `maxLatency control=${Math.max(...control.latenciesMs).toFixed(0)}ms hold=${Math.max(...hold.latenciesMs).toFixed(0)}ms; ` +
        `waits=${JSON.stringify({ control: controlWaits, hold: holdWaits })}; ` +
        `sampler: samples=${sampler.sampleCount}, errors=${sampler.errorCount}, top=${JSON.stringify(blocked[0])}`,
    );

    // Tiền điều kiện: control chạy thật và không lỗi, sampler tự nó không hỏng, khóa thực sự được giữ đủ lâu.
    expect(control.ok).toBeGreaterThan(0);
    expect(control.errors).toEqual({ deadlock: 0, timeout: 0, other: 0 });
    expect(hold.errors).toEqual({ deadlock: 0, timeout: 0, other: 0 });
    expect(sampler.errorCount, `sampler lỗi: ${sampler.lastError}`).toBe(0);
    expect(sampler.sampleCount).toBeGreaterThan(0);
    expect(heldUntil - heldFrom).toBeGreaterThanOrEqual(HOLD_MS * 0.9);
    expect(expectedInside).toBeGreaterThan(10); // có đủ tải ngoài khoảng giữ để phép so sánh có nghĩa

    // (a) trong khoảng giữ khóa gần như không thao tác nào hoàn tất.
    expect(insideHold).toBeLessThanOrEqual(0.1 * expectedInside);
    // (b) thời gian chờ khóa tăng rõ rệt so với control.
    expect(holdWait).toBeGreaterThan(500);
    expect(holdWait).toBeGreaterThan(10 * controlWait);
    // (b') thao tác bị giữ thật sự chờ cả quãng giữ khóa.
    expect(Math.max(...hold.latenciesMs)).toBeGreaterThanOrEqual(HOLD_MS / 2);
    // (c) sampler thấy request bị chặn trên câu lệnh update hot.
    expect(
      blocked.some(
        (b) => b.waitType.startsWith('LCK_M_') && /update\s+\[?hot\]?/.test(b.statement),
      ),
    ).toBe(true);
  });
});
