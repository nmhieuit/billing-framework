import { drainBatches } from '@billing/runtime';
import type { Clock, Logger, Metrics, TenantRegistry, TenantUnitOfWork } from './ports.js';

/** Thứ tự này là thứ tự khóa ngoại: item trước run, rồi các bảng độc lập. */
export const WALLET_RETENTION_POLICIES = [
  'reconciliation_items',
  'reconciliation_runs',
  'outbox_sent',
  'processed_messages',
  'idempotency_keys',
] as const;

export type WalletRetentionPolicy = (typeof WALLET_RETENTION_POLICIES)[number];

/** Trần khi đếm ở chế độ chạy thử (tránh đếm bảng khổng lồ). */
export const DRY_RUN_COUNT_CAP = 1_000_000;

export interface RetentionRepository {
  /**
   * Một lô: xóa tối đa `batchSize` dòng đủ điều kiện và trả số dòng đã xóa; khi `dryRun` chỉ đếm
   * (có trần `DRY_RUN_COUNT_CAP`) và không xóa gì.
   */
  purge(
    policy: WalletRetentionPolicy,
    cutoff: Date,
    batchSize: number,
    dryRun: boolean,
  ): Promise<number>;
}

export interface RetentionRow {
  tenant: string;
  table: WalletRetentionPolicy;
  count: number;
}

/** Kết quả một lượt dọn: chỉ gồm chính sách có `count > 0`. */
export interface RetentionReport {
  dryRun: boolean;
  rows: RetentionRow[];
  errors: number;
}

export interface WalletRetentionSettings {
  dryRun: boolean;
  batchSize: number;
  maxSecondsPerRun: number;
  days: {
    outboxSent: number;
    processedMessages: number;
    idempotencyKeys: number;
    reconciliation: number;
  };
}

const DAY_MS = 86_400_000;

function daysFor(policy: WalletRetentionPolicy, days: WalletRetentionSettings['days']): number {
  switch (policy) {
    case 'reconciliation_items':
    case 'reconciliation_runs':
      return days.reconciliation;
    case 'outbox_sent':
      return days.outboxSent;
    case 'processed_messages':
      return days.processedMessages;
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
      uow: TenantUnitOfWork;
      registry: TenantRegistry;
      clock: Clock;
      metrics: Metrics;
      log: Logger;
      settings: WalletRetentionSettings;
    },
  ) {}

  /**
   * Một lượt dọn dữ liệu cũ. Không bao giờ ném lỗi: lỗi của từng (tenant, chính sách) được đếm và ghi log.
   * Lượt có thể dừng sớm (hết ngân sách thời gian, bị hủy, hoặc lô ngắn do `readpast` bỏ qua dòng đang bị khóa);
   * lượt hằng giờ kế tiếp sẽ làm tiếp, nên báo cáo không khẳng định đã dọn hết.
   */
  async execute(signal?: AbortSignal): Promise<RetentionReport> {
    const { uow, registry, clock, metrics, log, settings } = this.deps;
    const started = clock.now();
    const deadline = started.getTime() + settings.maxSecondsPerRun * 1000;
    const mayContinue = (): boolean => !signal?.aborted && clock.now().getTime() < deadline;
    const rows: RetentionRow[] = [];
    let errors = 0;

    outer: for (const tenant of registry.all()) {
      for (const policy of WALLET_RETENTION_POLICIES) {
        if (!mayContinue()) break outer;
        const cutoff = new Date(started.getTime() - daysFor(policy, settings.days) * DAY_MS);
        // Đếm trong bước để giữ lại số dòng đã xóa trước khi một lô sau đó lỗi.
        let count = 0;
        try {
          if (settings.dryRun) {
            count = await uow.run(tenant, ({ retention }) =>
              retention.purge(policy, cutoff, settings.batchSize, true),
            );
          } else {
            await drainBatches(
              async (batchSize) => {
                const deleted = await uow.run(tenant, ({ retention }) =>
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
          log.warn(
            { err: error, tenantId: tenant.value, policy },
            'retention policy failed; continuing',
          );
        }
        if (count > 0) rows.push({ tenant: tenant.value, table: policy, count });
      }
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
