export type Task = () => Promise<number>;

export async function runSequential(tasks: Task[]): Promise<number[]> {
  const results: number[] = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results;
}

export async function runParallel(tasks: Task[]): Promise<number[]> {
  return Promise.all(tasks.map((task) => task()));
}
