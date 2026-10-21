export async function withRetry<T>(
  task: () => Promise<T>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) {
        throw error;
      }
      await sleep(delay);
    }
  }
}
