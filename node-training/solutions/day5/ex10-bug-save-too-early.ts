export function createRunner() {
  const saved = new Map<string, unknown>();
  return {
    run<T>(key: string, work: () => T): T {
      if (saved.has(key)) {
        return saved.get(key) as T;
      }
      const result = work();
      saved.set(key, result);
      return result;
    },
  };
}
