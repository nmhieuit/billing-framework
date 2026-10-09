export interface WorkerOptions {
  intervalMs: number;
  tasks: ReadonlyArray<() => Promise<unknown>>;
  onError: (error: unknown) => void;
}

/** Vòng lặp nền đơn giản: chạy các task lần lượt, không bao giờ chồng hai tick, dừng êm. */
export class Worker {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #inflight: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkerOptions) {}

  async tick(): Promise<void> {
    for (const task of this.options.tasks) {
      try {
        await task();
      } catch (error) {
        try {
          this.options.onError(error);
        } catch {
          // Bộ xử lý lỗi hỏng không được phép làm chết vòng lặp.
        }
      }
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (): void => {
      this.#inflight = this.tick().finally(() => {
        if (this.#running) this.#timer = setTimeout(loop, this.options.intervalMs);
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#inflight;
  }
}
