export function createSingleFlight() {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }
      const promise = work().catch((error: unknown) => {
        inFlight.delete(key);
        throw error;
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}
