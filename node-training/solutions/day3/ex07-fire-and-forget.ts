export function runInBackground(task: () => Promise<void>, onError: (error: unknown) => void): void {
  (async () => {
    await task();
  })().catch(onError);
}
