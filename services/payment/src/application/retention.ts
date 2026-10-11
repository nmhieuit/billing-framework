import { drainBatches } from '@billing/runtime';
import type { Clock, Logger, Metrics, UnitOfWork } from './ports.js';

/** Thứ tự này là thứ tự khóa ngoại: attempt trước event, rồi bảng độc lập. */
export const PAYMENT_RETENTION_POLICIES = [
  'webhook_attempts',
  'webhook_events',
  'idempotency_keys',
] as const;

export type PaymentRetentionPolicy = (typeof PAYMENT_RETENTION_POLICIES)[number];

/** Trần khi đếm ở chế độ chạy thử (tránh đếm bảng khổng lồ). */
export const DRY_RUN_COUNT_CAP = 1_000_000;

export interface RetentionRepository {
  /**
   * Một lô: xóa tối đa `batchSize` dòng đủ điều kiện và trả số dòng đã xóa; khi `dryRun` chỉ đếm
   * (có trần `DRY_RUN_COUNT_CAP`) và không xóa gì.
   */
  purge(
    policy: PaymentRetentionPolicy,
    cutoff: Date,
    batchSize: number,
    dryRun: boolean,
  ): Promise<number>;
}

export interface RetentionRow {
  table: PaymentRetentionPolicy;
  count: number;
}

/** Kết quả một lượt dọn: chỉ gồm chính sách có `count > 0`. */
export interface RetentionReport {
  dryRun: boolean;
  rows: RetentionRow[];
  errors: number;
}

export interface PaymentRetentionSettings {
  dryRun: boolean;
  batchSize: number;
  maxSecondsPerRun: number;
  days: { webhook: number; idempotencyKeys: number };
}

const DAY_MS = 86_400_000;

function daysFor(policy: PaymentRetentionPolicy, days: PaymentRetentionSettings['days']): number {
  switch (policy) {
    case 'webhook_attempts':
    case 'webhook_events':
      return days.webhook;
    case 'idempotency_keys':
      return days.idempotencyKeys;
    default: {
      const unreachable: never = policy;
      throw new Error(`unknown retention policy ${String(unreachable)}`);
    }
  }
}

export class RunRetention {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      metrics: Metrics;
      log: Logger;
      settings: PaymentRetentionSettings;
    },
  ) {}

  /**
   * Một lượt dọn dữ liệu cũ. Không bao giờ ném lỗi: lỗi của từng chính sách được đếm và ghi log.
   * Lượt có thể dừng sớm (hết ngân sách thời gian, bị hủy, hoặc lô ngắn do `readpast` bỏ qua dòng đang bị khóa);
   * lượt hằng giờ kế tiếp sẽ làm tiếp, nên báo cáo không khẳng định đã dọn hết.
   */
  async execute(signal?: AbortSignal): Promise<RetentionReport> {
    const { uow, clock, metrics, log, settings } = this.deps;
    const started = clock.now();
    const deadline = started.getTime() + settings.maxSecondsPerRun * 1000;
    const mayContinue = (): boolean => !signal?.aborted && clock.now().getTime() < deadline;
    const rows: RetentionRow[] = [];
    let errors = 0;

    for (const policy of PAYMENT_RETENTION_POLICIES) {
      if (!mayContinue()) break;
      const cutoff = new Date(started.getTime() - daysFor(policy, settings.days) * DAY_MS);
      // Đếm trong bước để giữ lại số dòng đã xóa trước khi một lô sau đó lỗi.
      let count = 0;
      try {
        if (settings.dryRun) {
          count = await uow.run(({ retention }) =>
            retention.purge(policy, cutoff, settings.batchSize, true),
          );
        } else {
          await drainBatches(
            async (batchSize) => {
              const deleted = await uow.run(({ retention }) =>
                retention.purge(policy, cutoff, batchSize, false),
              );
              count += deleted;
              return deleted;
            },
            { batchSize: settings.batchSize, shouldContinue: mayContinue },
          );
        }
      } catch (error) {
        errors += 1;
        log.warn({ err: error, policy }, 'retention policy failed; continuing');
      }
      if (count > 0) rows.push({ table: policy, count });
    }

    const report: RetentionReport = { dryRun: settings.dryRun, rows, errors };
    try {
      metrics.retentionRun(report);
    } catch (error) {
      log.warn({ err: error }, 'recording retention metrics failed');
    }
    if (rows.length > 0 || errors > 0) {
      log.info(
        {
          dryRun: report.dryRun,
          errors,
          rows: rows.reduce((sum, row) => sum + row.count, 0),
          policies: rows.length,
        },
        'retention run finished',
      );
    }
    return report;
  }
}
