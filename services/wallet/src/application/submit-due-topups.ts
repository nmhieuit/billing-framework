import type { TenantId } from '../domain/tenant-id.js';
import type { SubmitTopup } from './submit-topup.js';

const DEFAULT_BATCH = 50;

export interface SubmitReport {
  submitted: number;
  rejected: number;
  retrying: number;
  failed: number;
  superseded: number;
}

export class SubmitDueTopups {
  constructor(private readonly deps: { submit: Pick<SubmitTopup, 'executeNextDue'> }) {}

  /**
   * Mỗi vòng chiếm MỘT lần nạp ngay trước khi gửi (lease chỉ cần phủ một lần gọi), và kiểm tra
   * `shouldContinue` trước khi chiếm để dừng êm giữa các lần nạp khi worker bị dừng.
   */
  async execute(
    tenant: TenantId,
    limit = DEFAULT_BATCH,
    options: { shouldContinue?: () => boolean } = {},
  ): Promise<SubmitReport> {
    const report: SubmitReport = {
      submitted: 0,
      rejected: 0,
      retrying: 0,
      failed: 0,
      superseded: 0,
    };
    for (let i = 0; i < limit; i++) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      const outcome = await this.deps.submit.executeNextDue(tenant);
      if (outcome === null) break;
      if (outcome === 'SUBMITTED') report.submitted += 1;
      else if (outcome === 'REJECTED') report.rejected += 1;
      else if (outcome === 'RETRY_SCHEDULED') report.retrying += 1;
      else if (outcome === 'FAILED') report.failed += 1;
      else if (outcome === 'SUPERSEDED') report.superseded += 1;
    }
    return report;
  }
}
