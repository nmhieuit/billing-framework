export interface RunOutcome<T> {
  result: T;
  replayed: boolean;
}

export function createIdempotencyStore() {
  const saved = new Map<string, { fingerprint: string; result: unknown }>();
  return {
    run<T>(key: string, fingerprint: string, work: () => T): RunOutcome<T> {
      const previous = saved.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        }
        return { result: previous.result as T, replayed: true };
      }
      const result = work();
      saved.set(key, { fingerprint, result });
      return { result, replayed: false };
    },
  };
}
