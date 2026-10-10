import {
  classifyCharge,
  dayBounds,
  findMissingAtGateway,
  parseReconciliationDay,
  previousDay,
  totalsByCurrency,
  type AutofixAction,
  type Discrepancy,
} from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { ApplyPaymentResult } from './apply-payment-result.js';
import { ReconciliationTooLargeError } from './errors.js';
import type {
  Clock,
  IdGenerator,
  Logger,
  NewReconciliationItem,
  ReconciliationRun,
  RunTrigger,
  SettlementSource,
  TenantUnitOfWork,
} from './ports.js';

export interface RunHandle {
  tenant: TenantId;
  runId: string;
  day: string;
}

export interface RunReconciliationDeps {
  uow: TenantUnitOfWork;
  settlement: SettlementSource;
  /** Đường nạp tiền bình thường (chống trùng sẵn); đối soát không tự ghi sổ cách nào khác. */
  applyPayment: Pick<ApplyPaymentResult, 'execute'>;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  options: { autofix: boolean; maxItems: number };
}

interface GatewayCheck {
  discrepancies: Discrepancy[];
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
}

interface Autofix {
  action: AutofixAction;
  detail: Record<string, unknown>;
}

const MAX_LISTED_CREDITED = 5;

/** Lý do thất bại (cột 500 ký tự), kèm danh sách lần nạp đã được ghi bù trước khi lỗi xảy ra. */
function failureReason(error: unknown, credited: readonly string[]): string {
  const base = (error instanceof Error ? error.message : 'unexpected error').slice(0, 200);
  if (credited.length === 0) return base;
  const listed = credited.slice(0, MAX_LISTED_CREDITED).join(', ');
  const more = credited.length > MAX_LISTED_CREDITED ? ', ...' : '';
  return `${base}; ${credited.length} topups already auto-credited: ${listed}${more}`;
}

/** Một lượt đối soát cho một tenant và một ngày UTC. Mặc định chỉ đọc; chỉ tự ghi bù `MISSING_AT_WALLET`. */
export class RunReconciliation {
  constructor(private readonly deps: RunReconciliationDeps) {}

  /** Tạo lượt `RUNNING`; `null` nếu lượt `SCHEDULED` của ngày đó đã có. Ném `InvalidReconciliationError` khi ngày sai. */
  async begin(input: {
    tenant: TenantId;
    day: string;
    triggeredBy: RunTrigger;
  }): Promise<RunHandle | null> {
    const now = this.deps.clock.now();
    const day = parseReconciliationDay(input.day, now);
    const runId = this.deps.ids.eventId();
    const started = await this.deps.uow.run(input.tenant, ({ reconciliation }) =>
      reconciliation.startRun({ id: runId, day, triggeredBy: input.triggeredBy, startedAt: now }),
    );
    return started ? { tenant: input.tenant, runId, day } : null;
  }

  async execute(input: {
    tenant: TenantId;
    day: string;
    triggeredBy: RunTrigger;
  }): Promise<ReconciliationRun | null> {
    const handle = await this.begin(input);
    return handle === null ? null : this.finish(handle);
  }

  /** Chạy các phép kiểm tra và đóng lượt. Lỗi dự kiến (sao kê, quá lớn, lỗi bất ngờ) đóng lượt `FAILED`, không ném. */
  async finish(handle: RunHandle): Promise<ReconciliationRun> {
    const { tenant, runId, day } = handle;
    // Các lần nạp đã được ghi bù trong lượt này (mỗi lần là một transaction đã commit), để không mất dấu nếu lượt thất bại.
    const credited: string[] = [];
    try {
      const ledger = await this.checkLedger(tenant);
      const gateway = await this.checkGateway(tenant, day);
      const found = [...ledger, ...gateway.discrepancies];
      if (found.length > this.deps.options.maxItems) {
        throw new ReconciliationTooLargeError(
          `found ${found.length} discrepancies, more than the limit of ${this.deps.options.maxItems}`,
        );
      }

      const items: NewReconciliationItem[] = [];
      for (const discrepancy of found) {
        const fix =
          discrepancy.kind === 'MISSING_AT_WALLET' && this.deps.options.autofix
            ? await this.autofix(tenant, runId, discrepancy, credited)
            : null;
        items.push({
          id: this.deps.ids.eventId(),
          ...discrepancy,
          action: fix?.action ?? 'NONE',
          detail: { ...discrepancy.detail, ...fix?.detail },
        });
      }

      const finishedAt = this.deps.clock.now();
      await this.deps.uow.run(tenant, ({ reconciliation }) =>
        reconciliation.completeRun(runId, {
          gatewayTotals: gateway.gatewayTotals,
          walletTotals: gateway.walletTotals,
          items,
          finishedAt,
        }),
      );
      this.report(tenant, runId, day, items);
    } catch (error) {
      const reason = failureReason(error, credited);
      this.deps.log.error(
        { err: error, tenantId: tenant.value, runId, day, credited },
        'reconciliation run failed',
      );
      const recorded = await this.deps.uow.run(tenant, ({ reconciliation }) =>
        reconciliation.failRun(runId, reason, this.deps.clock.now()),
      );
      if (!recorded && credited.length > 0) {
        // Lượt đã bị đóng (quét bỏ dở) nên lý do không ghi được: ghi log để không mất dấu các lần nạp đã ghi bù.
        this.deps.log.error(
          { tenantId: tenant.value, runId, day, credited },
          'reconciliation run was already closed; topups credited by it are listed here',
        );
      }
    }
    const run = await this.deps.uow.run(tenant, ({ reconciliation }) =>
      reconciliation.findRun(runId),
    );
    if (run === null) throw new Error(`reconciliation run ${runId} disappeared`);
    return run;
  }

  private async checkLedger(tenant: TenantId): Promise<Discrepancy[]> {
    const { unbalanced, drift } = await this.deps.uow.run(tenant, async ({ reconciliation }) => ({
      unbalanced: await reconciliation.findUnbalancedTransactions(),
      drift: await reconciliation.findBalanceMismatches(),
    }));
    const none = {
      chargeId: null,
      topupId: null,
      amountGateway: null,
      amountWallet: null,
      currency: null,
    };
    return [
      ...unbalanced.map((u): Discrepancy => ({
        ...none,
        kind: 'LEDGER_UNBALANCED',
        detail: { transactionId: u.transactionId, total: u.total },
      })),
      ...drift.map((d): Discrepancy => ({
        ...none,
        kind: 'BALANCE_MISMATCH',
        detail: { accountId: d.accountId, balance: d.balance, ledgerTotal: d.ledgerTotal },
      })),
    ];
  }

  private async checkGateway(tenant: TenantId, day: string): Promise<GatewayCheck> {
    const max = this.deps.options.maxItems;
    // Webhook có thể đến sau nửa đêm: charge hoàn tất ngày D-1 nhưng wallet ghi nhận ngày D. Chỉ dùng D-1 để tra cứu.
    const today = await this.deps.settlement.fetchDay(day, max);
    const before = await this.deps.settlement.fetchDay(previousDay(day), max);
    const mine = today.filter((charge) => charge.tenantId === tenant.value);

    const topups = await this.deps.uow.run(tenant, ({ reconciliation }) =>
      reconciliation.findTopupsByIds(mine.map((charge) => charge.reference)),
    );
    const byId = new Map(topups.map((topup) => [topup.id, topup]));
    const discrepancies: Discrepancy[] = [];
    for (const charge of mine) {
      const discrepancy = classifyCharge(charge, byId.get(charge.reference) ?? null);
      if (discrepancy !== null) discrepancies.push(discrepancy);
    }

    const { from, to } = dayBounds(day);
    const succeeded = await this.deps.uow.run(tenant, ({ reconciliation }) =>
      reconciliation.listSucceededTopups(from, to),
    );
    const known = new Set([...today, ...before].map((charge) => charge.chargeId));
    discrepancies.push(...findMissingAtGateway(succeeded, known));

    return {
      discrepancies,
      gatewayTotals: totalsByCurrency(mine.filter((charge) => charge.status === 'SUCCEEDED')),
      walletTotals: totalsByCurrency(succeeded),
    };
  }

  /** Ghi bù một lần nạp mà payment đã xác nhận thành công. Mỗi lần là một transaction riêng; lỗi không lan sang dòng khác. */
  private async autofix(
    tenant: TenantId,
    runId: string,
    d: Discrepancy,
    credited: string[],
  ): Promise<Autofix> {
    if (
      d.chargeId === null ||
      d.topupId === null ||
      d.amountGateway === null ||
      d.currency === null
    ) {
      return { action: 'FAILED_AUTOFIX', detail: { autofix: 'incomplete discrepancy' } };
    }
    const topupId = d.topupId;
    try {
      // eventId theo lượt: một lần thử thất bại trước đó không chặn lượt sau; chống ghi hai lần nhờ business key `topup:<id>`.
      const outcome = await this.deps.applyPayment.execute({
        tenant,
        eventId: `reconcile:${runId}:${d.chargeId}`,
        type: 'charge.succeeded',
        chargeId: d.chargeId,
        reference: topupId,
        amount: d.amountGateway,
        currency: d.currency,
      });
      if (outcome === 'APPLIED') {
        credited.push(topupId);
        // Ghi log ngay khi đã ghi sổ, để vẫn còn dấu vết dù lượt đối soát thất bại sau đó.
        this.deps.log.info(
          {
            tenantId: tenant.value,
            runId,
            chargeId: d.chargeId,
            topupId,
            amount: d.amountGateway,
            currency: d.currency,
          },
          'reconciliation credited a topup whose webhook was lost',
        );
        return { action: 'AUTO_APPLIED', detail: { autofix: 'APPLIED' } };
      }
      if (outcome === 'IGNORED') {
        // Webhook thật đến trước: lần nạp đã SUCCEEDED thì coi như đã xử lý xong.
        const now = await this.deps.uow.run(tenant, ({ topups }) => topups.findById(topupId));
        if (now?.toProps().status === 'SUCCEEDED') {
          return { action: 'AUTO_APPLIED', detail: { autofix: 'already settled' } };
        }
      }
      return { action: 'FAILED_AUTOFIX', detail: { autofix: outcome } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      return {
        action: 'FAILED_AUTOFIX',
        detail: { autofix: 'error', error: message.slice(0, 200) },
      };
    }
  }

  private report(
    tenant: TenantId,
    runId: string,
    day: string,
    items: readonly NewReconciliationItem[],
  ): void {
    for (const item of items) {
      const details = {
        tenantId: tenant.value,
        runId,
        day,
        kind: item.kind,
        chargeId: item.chargeId,
        topupId: item.topupId,
      };
      if (item.kind === 'LEDGER_UNBALANCED' || item.kind === 'BALANCE_MISMATCH') {
        this.deps.log.error({ ...details, detail: item.detail }, 'ledger integrity check failed');
      } else if (item.action === 'AUTO_APPLIED') {
        // Log "đã ghi bù" đã được ghi ngay lúc ghi sổ (xem `autofix`); ở đây chỉ ghi nhận dòng, không khẳng định có ghi bù.
        this.deps.log.info(
          { ...details, autofix: item.detail.autofix },
          'reconciliation auto-applied item recorded',
        );
      } else {
        this.deps.log.warn(
          { ...details, action: item.action },
          'reconciliation found a discrepancy that needs a human',
        );
      }
    }
  }
}
