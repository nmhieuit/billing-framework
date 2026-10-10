import type { TenantId } from '../domain/tenant-id.js';
import type { Logger, TopupSubmitter } from './ports.js';
import type { SubmitTopup } from './submit-topup.js';

/**
 * Lần thử gửi ngay sau khi `POST /topups` commit. Không chờ, không làm hỏng request; nếu lỗi thì lần nạp vẫn
 * `REQUESTED` và worker sẽ gửi lại. Theo dõi các lần thử đang chạy để dịch vụ tắt không cắt ngang chúng.
 */
export class InlineTopupSubmitter implements TopupSubmitter {
  readonly #pending = new Set<Promise<void>>();

  constructor(private readonly deps: { submit: Pick<SubmitTopup, 'executeFor'>; log: Logger }) {}

  submitSoon(tenant: TenantId, topupId: string): void {
    const attempt: Promise<void> = (async () => {
      await this.deps.submit.executeFor(tenant, topupId);
    })()
      .catch((error: unknown) => {
        try {
          this.deps.log.error(
            { err: error, tenantId: tenant.value, topupId },
            'inline topup submission failed; the worker will retry',
          );
        } catch {
          // Logger hỏng không được phép biến thành lỗi chưa xử lý.
        }
      })
      .finally(() => {
        this.#pending.delete(attempt);
      });
    this.#pending.add(attempt);
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
