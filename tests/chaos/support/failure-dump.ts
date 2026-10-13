import type { OpLog } from './op-log.js';
import type { System } from './system-harness.js';

/** Phần tối thiểu của `ctx.task` mà bộ ghi cần (tách ra để test được mà không cần vitest). */
export interface FailedTask {
  name: string;
  result?: { state?: string; errors?: ReadonlyArray<{ message?: string }> };
}

/** Tên tệp nhật ký an toàn cho hệ điều hành: `<tên test rút gọn>-seed<seed>`. */
export const dumpName = (taskName: string, seed: number): string =>
  `${taskName.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-seed${seed}`;

/** Ghi lý do thất bại của test vào OpLog TRƯỚC khi ghi tệp, để nhật ký tự nó cho biết vì sao test hỏng. */
export function recordTaskFailure(log: OpLog, task: FailedTask): void {
  log.record('test.failure', {
    test: task.name,
    errors: (task.result?.errors ?? []).map((e) => e.message ?? String(e)),
  });
}

/**
 * Dùng trong `afterEach(async (ctx) => dumpFailedTask(ctx.task, system, outDir))`. Test thất bại ⇒ ghi lý do + nhật ký thao tác,
 * rồi cố gắng (best-effort, không ném lỗi) heal() để hệ dùng chung không đổ lỗi dây chuyền sang test sau.
 */
export async function dumpFailedTask(
  task: FailedTask,
  system: System | undefined,
  outDir: string,
): Promise<void> {
  if (task.result?.state !== 'fail' || system === undefined) return;
  recordTaskFailure(system.log, task);
  const path = await system.log.writeTo(outDir, dumpName(task.name, system.seed));
  console.error(`[chaos] seed=${system.seed}, nhật ký thao tác: ${path}`);
  try {
    await system.heal({ allowUnsettledTopups: true, timeoutMs: 60_000 });
  } catch (error) {
    console.error(
      `[chaos] heal() sau test thất bại cũng thất bại (bỏ qua): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
