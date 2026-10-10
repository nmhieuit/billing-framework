import type { Logger } from './ports.js';

/**
 * Chạy việc nền không chờ (lượt đối soát do API khởi tạo). Không để lỗi thành rejection chưa xử lý và cho phép
 * dịch vụ tắt đợi các việc đang chạy.
 */
export class BackgroundRuns {
  readonly #pending = new Set<Promise<void>>();

  constructor(private readonly log: Logger) {}

  submit(context: object, work: () => Promise<unknown>): void {
    const task: Promise<void> = (async () => {
      await work();
    })()
      .catch((error: unknown) => {
        try {
          this.log.error({ err: error, ...context }, 'background reconciliation failed');
        } catch {
          // Logger hỏng không được phép biến thành lỗi chưa xử lý.
        }
      })
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
