import { yesterdayUtc } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Clock, Logger, TenantUnitOfWork } from './ports.js';
import type { RunReconciliation } from './run-reconciliation.js';

/** Lượt `RUNNING` quá hạn này coi như worker đã chết giữa chừng. */
export const STALE_RUN_MINUTES = 30;
/** Lượt định kỳ thất bại chỉ được thử lại sau khoảng này. */
export const RETRY_AFTER_MINUTES = 15;

export type ScheduleOutcome =
  'TOO_EARLY' | 'DONE' | 'IN_PROGRESS' | 'GAVE_UP' | 'WAITING' | 'SKIPPED' | 'RAN';

/** Mỗi tick của worker: đối soát ngày hôm qua (UTC) cho một tenant nếu chưa làm xong. An toàn khi nhiều worker chạy song song. */
export class ScheduleDailyReconciliation {
  /** tenant → ngày đã xong hoặc đã bỏ cuộc; tránh truy vấn DB mỗi 500 ms sau đó. */
  readonly #settled = new Map<string, { day: string; outcome: 'DONE' | 'GAVE_UP' }>();

  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      run: Pick<RunReconciliation, 'execute'>;
      clock: Clock;
      log: Logger;
      options: { atUtcHour: number; maxAttempts: number };
    },
  ) {}

  async execute(tenant: TenantId): Promise<ScheduleOutcome> {
    const now = this.deps.clock.now();
    if (now.getUTCHours() < this.deps.options.atUtcHour) return 'TOO_EARLY';
    const day = yesterdayUtc(now);
    const settled = this.#settled.get(tenant.value);
    if (settled?.day === day) return settled.outcome;

    const staleBefore = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
    const state = await this.deps.uow.run(tenant, async ({ reconciliation }) => {
      const stale = await reconciliation.failStaleRuns(
        staleBefore,
        'abandoned: the run did not finish in time',
        now,
      );
      return { stale, ...(await reconciliation.scheduledRunsFor(day)) };
    });
    if (state.stale > 0) {
      this.deps.log.warn(
        { tenantId: tenant.value, day, stale: state.stale },
        'abandoned stale reconciliation runs',
      );
    }

    if (state.completed > 0) {
      this.#settled.set(tenant.value, { day, outcome: 'DONE' });
      return 'DONE';
    }
    if (state.running > 0) return 'IN_PROGRESS';
    if (state.failed >= this.deps.options.maxAttempts) {
      this.#settled.set(tenant.value, { day, outcome: 'GAVE_UP' });
      this.deps.log.error(
        { tenantId: tenant.value, day, attempts: state.failed },
        'scheduled reconciliation gave up; run it manually once the cause is fixed',
      );
      return 'GAVE_UP';
    }
    if (
      state.lastFailedAt !== null &&
      now.getTime() - state.lastFailedAt.getTime() < RETRY_AFTER_MINUTES * 60_000
    ) {
      return 'WAITING';
    }

    const run = await this.deps.run.execute({ tenant, day, triggeredBy: 'SCHEDULED' });
    if (run === null) return 'SKIPPED';
    if (run.status === 'COMPLETED') this.#settled.set(tenant.value, { day, outcome: 'DONE' });
    return 'RAN';
  }
}
