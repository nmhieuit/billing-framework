export interface QuiesceCondition {
  name: string;
  check: () => Promise<boolean>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Chạy một lần kiểm tra với hạn riêng: kiểm tra treo cho ra lỗi có TÊN điều kiện thay vì để cả test hết giờ mà không biết vì đâu.
async function runCheck(condition: QuiesceCondition, limitMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`kiểm tra "${condition.name}" treo quá ${limitMs}ms`)),
      limitMs,
    );
  });
  try {
    return await Promise.race([condition.check(), hung]);
  } finally {
    clearTimeout(timer);
  }
}

// Thăm dò đến khi mọi điều kiện cùng đạt; điều kiện ném lỗi (hoặc treo quá `checkTimeoutMs`) được coi là chưa đạt.
export async function quiesce(
  conditions: readonly QuiesceCondition[],
  options: { timeoutMs?: number; intervalMs?: number; checkTimeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 200;
  const checkTimeoutMs = options.checkTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let pending: string[] = [];
  const lastErrors = new Map<string, string>();

  for (;;) {
    pending = [];
    for (const condition of conditions) {
      try {
        // Hạn mỗi lần kiểm tra không vượt quá phần thời gian còn lại của cả quiesce.
        const limit = Math.max(1, Math.min(checkTimeoutMs, deadline - Date.now()));
        if (await runCheck(condition, limit)) {
          lastErrors.delete(condition.name);
        } else {
          // Trả false mà không ném: lỗi cũ (nếu có) không còn đúng, đừng báo nó như "lỗi cuối".
          lastErrors.delete(condition.name);
          pending.push(condition.name);
        }
      } catch (error) {
        pending.push(condition.name);
        lastErrors.set(condition.name, error instanceof Error ? error.message : String(error));
      }
    }
    if (pending.length === 0) return;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  const detail = pending
    .map((name) => {
      const err = lastErrors.get(name);
      return err === undefined ? name : `${name} (lỗi cuối: ${err})`;
    })
    .join(', ');
  throw new Error(`quiesce hết hạn sau ${timeoutMs}ms, điều kiện chưa đạt: ${detail}`);
}
