export interface QuiesceCondition {
  name: string;
  check: () => Promise<boolean>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Thăm dò đến khi mọi điều kiện cùng đạt; điều kiện ném lỗi được coi là chưa đạt.
export async function quiesce(
  conditions: readonly QuiesceCondition[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let pending: string[] = [];
  const lastErrors = new Map<string, string>();

  for (;;) {
    pending = [];
    for (const condition of conditions) {
      try {
        if (await condition.check()) {
          lastErrors.delete(condition.name);
        } else {
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
