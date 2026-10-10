import type { TenantId } from '../domain/tenant-id.js';
import type {
  Clock,
  Logger,
  Metrics,
  QueueDepthReader,
  TenantRegistry,
  TenantUnitOfWork,
} from './ports.js';
import type { TenantState, WalletState } from './state.js';

const ageSeconds = (now: Date, at: Date | null): number =>
  at === null ? 0 : Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));

/** Chụp trạng thái cần đo (outbox, nạp tiền, đối soát, DLQ) và đẩy sang `Metrics`. Lỗi một tenant không chặn tenant khác. */
export class SampleState {
  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      registry: TenantRegistry;
      queueDepth: QueueDepthReader;
      dlqQueue: string;
      metrics: Metrics;
      clock: Clock;
      log: Logger;
    },
  ) {}

  async execute(): Promise<WalletState> {
    const now = this.deps.clock.now();
    const tenants: TenantState[] = [];
    for (const tenant of this.deps.registry.all()) {
      try {
        tenants.push(await this.sampleTenant(tenant, now));
      } catch (error) {
        this.deps.log.warn(
          { err: error, tenantId: tenant.value },
          'sampling tenant state failed; skipping',
        );
      }
    }
    let dlqDepth: number | null = null;
    try {
      dlqDepth = await this.deps.queueDepth.depth(this.deps.dlqQueue);
    } catch (error) {
      this.deps.log.warn({ err: error }, 'reading the dead-letter queue depth failed');
    }
    const state: WalletState = { tenants, dlqDepth };
    this.deps.metrics.publishState(state);
    return state;
  }

  private async sampleTenant(tenant: TenantId, now: Date): Promise<TenantState> {
    const s = await this.deps.uow.run(tenant, ({ state }) => state.snapshot());
    return {
      tenant: tenant.value,
      outboxPending: s.outboxPending,
      outboxOldestAgeSeconds: ageSeconds(now, s.outboxOldestCreatedAt),
      topupsRequestedBacklog: s.topupsRequested,
      topupsOldestRequestedAgeSeconds: ageSeconds(now, s.topupsOldestCreatedAt),
      openItemsByKind: s.openItemsByKind,
      oldestOpenItemAgeSeconds: ageSeconds(now, s.oldestOpenItemCreatedAt),
      lastReconciliationSuccessAgeSeconds:
        s.lastReconciliationSuccessAt === null
          ? null
          : ageSeconds(now, s.lastReconciliationSuccessAt),
    };
  }
}
