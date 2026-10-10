export interface WorkerOptions {
  intervalMs: number;
  /** Mỗi task nhận một signal; signal bị abort khi `stop()` được gọi để task dừng sớm giữa các bước. */
  tasks: ReadonlyArray<(signal: AbortSignal) => Promise<unknown>>;
  onError: (error: unknown) => void;
}

/** Vòng lặp nền đơn giản: chạy các task lần lượt, không bao giờ chồng hai tick, dừng êm. */
export class Worker {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #inflight: Promise<void> = Promise.resolve();
  #abort = new AbortController();

  constructor(private readonly options: WorkerOptions) {}

  async tick(): Promise<void> {
    const { signal } = this.#abort;
    for (const task of this.options.tasks) {
      if (signal.aborted) return;
      try {
        await task(signal);
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
    this.#abort = new AbortController();
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
    this.#abort.abort();
    await this.#inflight;
  }
}
