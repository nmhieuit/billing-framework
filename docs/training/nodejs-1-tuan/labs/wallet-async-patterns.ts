// Bài lab Ngày 2: ba mẫu bất đồng bộ THẬT của wallet, chạy bằng code thật của repo.
//   1. StartManualReconciliation + BackgroundRuns (POST /reconciliations): await rồi chạy nền
//   2. Worker (vòng lặp nền của wallet): setTimeout + AbortSignal + stop() chờ tick đang chạy
//   3. Vì sao test dùng setImmediate để "flush": ranh giới macrotask = mọi microtask đã chạy xong
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/wallet-async-patterns.ts
import { BackgroundRuns } from '../../../../services/wallet/src/application/background-runs.js';
import { StartManualReconciliation } from '../../../../services/wallet/src/application/start-manual-reconciliation.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { Worker, createShutdownHandler } from '../../../../packages/runtime/src/index.js';

const t0 = Date.now();
const log = (msg: string): void => console.log(`+${String(Date.now() - t0).padStart(3)}ms  ${msg}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------------------------
console.log('=== 1. POST /reconciliations: tạo lượt (await) rồi chạy phần nặng NỀN (không await) ===');
{
  const background = new BackgroundRuns(noopLogger);
  const start = new StartManualReconciliation({
    run: {
      async begin() {
        log('    [begin] ghi dòng reconciliation_runs (DB)');
        await sleep(15);
        return { runId: 'run_1' } as never;
      },
      async finish() {
        log('    [finish] đọc sao kê payment + đối chiếu (phần nặng) BẮT ĐẦU');
        await sleep(100);
        log('    [finish] đối soát XONG');
      },
    } as never,
    background,
  });
  log('request: POST /reconciliations đến');
  const response = await start.execute({ tenant: TenantId.parse('acme'), day: '2026-10-19' });
  log(`request: >>> TRẢ ${JSON.stringify(response)} (client không phải chờ đối soát)`);
  log('server: tắt dịch vụ -> background.drain() phải chờ lượt đang chạy');
  await background.drain();
  log('server: drain xong, an toàn để đóng DB');
}

// ---------------------------------------------------------------------------------------------
console.log('\n=== 2. Worker: setTimeout nối tick, AbortSignal dừng giữa các tenant, stop() chờ việc đang chạy ===');
{
  const tenants = ['acme', 'beta', 'gamma'];
  // Mô phỏng submitDueForAllTenants (services/wallet/src/bootstrap.ts:212-226).
  const submitDueForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of tenants) {
      if (signal.aborted) {
        log(`    [task] signal.aborted -> bỏ qua ${tenant}`);
        return;
      }
      log(`    [task] xử lý ${tenant} (await DB 40ms)`);
      await sleep(40);
      log(`    [task] xong ${tenant}`);
    }
  };
  const worker = new Worker({
    intervalMs: 1000,
    tasks: [submitDueForAllTenants],
    onError: (error) => log(`onError ${String(error)}`),
  });
  worker.start();
  await sleep(60); // đang xử lý tenant thứ hai (beta)
  log('server: gọi worker.stop()');
  await worker.stop();
  log('server: stop() xong. Không có tick mới (không còn setTimeout nào được đặt).');
}

// ---------------------------------------------------------------------------------------------
console.log('\n=== 3. Vì sao test dùng setImmediate làm "flush" (lifecycle.test.ts:4) ===');
{
  const runCase = async (name: string, wait: () => Promise<void>): Promise<void> => {
    let exited = false;
    const handler = createShutdownHandler({
      // stop() có chuỗi await lồng 3 tầng, giống stop() thật của wallet (nhiều bước đóng).
      stop: async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      },
      log: { info: () => {}, error: () => {} },
      exit: () => {
        exited = true;
      },
    });
    handler('SIGTERM');
    await wait();
    log(`${name}: exit() đã được gọi chưa? ${exited ? 'RỒI' : 'CHƯA'}`);
    await sleep(5); // để lần sau không bị ảnh hưởng
  };
  await runCase('chờ 1 microtask  (await Promise.resolve())', () => Promise.resolve());
  await runCase('chờ 1 macrotask  (await setImmediate)      ', () => new Promise((r) => setImmediate(r)));
}
