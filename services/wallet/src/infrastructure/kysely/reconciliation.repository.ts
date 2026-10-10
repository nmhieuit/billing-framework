import { isUniqueViolation, toSafeInteger } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  NewReconciliationItem,
  ReconciliationItem,
  ReconciliationRepository,
  ReconciliationRun,
  RunStatus,
  RunTrigger,
} from '../../application/ports.js';
import type { CaseStatus, WalletTopupView } from '../../domain/reconciliation.js';
import { sqlDate } from './mappers.js';
import type {
  ReconciliationItemsTable,
  ReconciliationRunsTable,
  TopupsTable,
  WalletDatabase,
} from './schema.js';

/** SQL Server giới hạn 2100 tham số mỗi câu lệnh: chia nhỏ các lệnh insert và `in (...)`. */
const ITEM_CHUNK = 100;
const ID_CHUNK = 500;
const LEDGER_CHECK_LIMIT = 1000;
const SYSTEM = 'system';
const AUTO_NOTE = 'auto-applied by reconciliation';

const chunks = <T>(values: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

const nullableInt = (value: string | null): number | null =>
  value === null ? null : toSafeInteger(value);

function rowToRun(row: Selectable<ReconciliationRunsTable>): ReconciliationRun {
  return {
    id: row.id,
    day: row.run_day,
    status: row.status as RunStatus,
    triggeredBy: row.triggered_by as RunTrigger,
    failureReason: row.failure_reason,
    gatewayTotals: JSON.parse(row.gateway_totals) as Record<string, number>,
    walletTotals: JSON.parse(row.wallet_totals) as Record<string, number>,
    itemCount: row.item_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToItem(row: Selectable<ReconciliationItemsTable>): ReconciliationItem {
  return {
    seq: Number(row.seq),
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ReconciliationItem['kind'],
    chargeId: row.charge_id,
    topupId: row.topup_id,
    amountGateway: nullableInt(row.amount_gateway),
    amountWallet: nullableInt(row.amount_wallet),
    currency: row.currency,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    action: row.action as ReconciliationItem['action'],
    caseStatus: row.case_status as CaseStatus,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function rowToTopupView(row: Selectable<TopupsTable>): WalletTopupView {
  return {
    id: row.id,
    chargeId: row.charge_id,
    amount: toSafeInteger(row.amount),
    currency: row.currency,
    status: row.status as WalletTopupView['status'],
    failureCode: row.failure_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const ITEM_COLUMNS = sql.raw(
  'seq, id, run_id, kind, charge_id, topup_id, amount_gateway, amount_wallet, currency, detail, action, case_status, resolved_by, resolution_note, resolved_at, created_at',
);

export class KyselyReconciliationRepository implements ReconciliationRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async startRun(run: {
    id: string;
    day: string;
    triggeredBy: RunTrigger;
    startedAt: Date;
  }): Promise<boolean> {
    try {
      await this.db
        .insertInto('reconciliation_runs')
        .values({
          id: run.id,
          run_day: run.day,
          status: 'RUNNING',
          triggered_by: run.triggeredBy,
          failure_reason: null,
          gateway_totals: '{}',
          wallet_totals: '{}',
          item_count: 0,
          started_at: sqlDate(run.startedAt),
          finished_at: null,
        })
        .execute();
      return true;
    } catch (error) {
      // Chỉ chỉ mục "một lượt định kỳ mỗi ngày" mới là trùng bình thường; mọi trùng khóa khác là lỗi thật.
      if (isUniqueViolation(error) && run.triggeredBy === 'SCHEDULED') return false;
      throw error;
    }
  }

  async completeRun(
    id: string,
    input: {
      gatewayTotals: Record<string, number>;
      walletTotals: Record<string, number>;
      items: readonly NewReconciliationItem[];
      finishedAt: Date;
    },
  ): Promise<void> {
    for (const part of chunks(input.items, ITEM_CHUNK)) {
      await this.db
        .insertInto('reconciliation_items')
        .values(
          part.map((item) => {
            const auto = item.action === 'AUTO_APPLIED';
            return {
              id: item.id,
              run_id: id,
              kind: item.kind,
              charge_id: item.chargeId,
              topup_id: item.topupId,
              amount_gateway: item.amountGateway,
              amount_wallet: item.amountWallet,
              currency: item.currency,
              detail: JSON.stringify(item.detail),
              action: item.action,
              case_status: auto ? 'RESOLVED' : 'OPEN',
              resolved_by: auto ? SYSTEM : null,
              resolution_note: auto ? AUTO_NOTE : null,
              resolved_at: auto ? sqlDate(input.finishedAt) : null,
              created_at: sqlDate(input.finishedAt),
            };
          }),
        )
        .execute();
    }
    const result = await this.db
      .updateTable('reconciliation_runs')
      .set({
        status: 'COMPLETED',
        gateway_totals: JSON.stringify(input.gatewayTotals),
        wallet_totals: JSON.stringify(input.walletTotals),
        item_count: input.items.length,
        finished_at: sqlDate(input.finishedAt),
      })
      .where('id', '=', id)
      .where('status', '=', 'RUNNING')
      .executeTakeFirst();
    // Lượt đã bị quét "bỏ dở" (FAILED): ném lỗi để transaction hoàn tác các dòng vừa chèn.
    if (Number(result.numUpdatedRows) !== 1) {
      throw new Error(`reconciliation run ${id} is no longer RUNNING; items were not stored`);
    }
  }

  async failRun(id: string, reason: string, finishedAt: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('reconciliation_runs')
      .set({
        status: 'FAILED',
        failure_reason: reason.slice(0, 500),
        finished_at: sqlDate(finishedAt),
      })
      .where('id', '=', id)
      .where('status', '=', 'RUNNING')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async failStaleRuns(startedBefore: Date, reason: string, now: Date): Promise<number> {
    const result = await this.db
      .updateTable('reconciliation_runs')
      .set({ status: 'FAILED', failure_reason: reason.slice(0, 500), finished_at: sqlDate(now) })
      .where('status', '=', 'RUNNING')
      .where('started_at', '<', sqlDate(startedBefore))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async findRun(id: string): Promise<ReconciliationRun | null> {
    const row = await this.db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToRun(row) : null;
  }

  async scheduledRunsFor(day: string): Promise<{
    running: number;
    completed: number;
    failed: number;
    lastFailedAt: Date | null;
  }> {
    const rows = await this.db
      .selectFrom('reconciliation_runs')
      .select(['status', 'finished_at'])
      .where('run_day', '=', day)
      .where('triggered_by', '=', 'SCHEDULED')
      .execute();
    const failed = rows.filter((row) => row.status === 'FAILED');
    const times = failed.flatMap((row) => (row.finished_at ? [row.finished_at.getTime()] : []));
    return {
      running: rows.filter((row) => row.status === 'RUNNING').length,
      completed: rows.filter((row) => row.status === 'COMPLETED').length,
      failed: failed.length,
      lastFailedAt: times.length > 0 ? new Date(Math.max(...times)) : null,
    };
  }

  async listItems(query: {
    runId: string;
    caseStatus: CaseStatus | null;
    afterSeq: number;
    limit: number;
  }): Promise<ReconciliationItem[]> {
    const rows = await this.db
      .selectFrom('reconciliation_items')
      .selectAll()
      .where('run_id', '=', query.runId)
      .where(sql<boolean>`seq > ${query.afterSeq}`)
      .$if(query.caseStatus !== null, (qb) =>
        qb.where('case_status', '=', query.caseStatus as CaseStatus),
      )
      .orderBy(sql`seq`)
      .top(query.limit)
      .execute();
    return rows.map(rowToItem);
  }

  async lockItem(id: string): Promise<ReconciliationItem | null> {
    const result = await sql<Selectable<ReconciliationItemsTable>>`
      select ${ITEM_COLUMNS} from ${sql.id(this.schema, 'reconciliation_items')} with (updlock, rowlock)
      where id = ${id}`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToItem(row) : null;
  }

  async resolveItem(
    id: string,
    resolution: { status: 'RESOLVED' | 'IGNORED'; resolvedBy: string; note: string; at: Date },
  ): Promise<void> {
    await this.db
      .updateTable('reconciliation_items')
      .set({
        case_status: resolution.status,
        resolved_by: resolution.resolvedBy,
        resolution_note: resolution.note,
        resolved_at: sqlDate(resolution.at),
      })
      .where('id', '=', id)
      .where('case_status', '=', 'OPEN')
      .execute();
  }

  async findTopupsByIds(ids: readonly string[]): Promise<WalletTopupView[]> {
    const views: WalletTopupView[] = [];
    for (const part of chunks([...new Set(ids)], ID_CHUNK)) {
      const rows = await this.db.selectFrom('topups').selectAll().where('id', 'in', part).execute();
      views.push(...rows.map(rowToTopupView));
    }
    return views;
  }

  async listSucceededTopups(from: Date, to: Date): Promise<WalletTopupView[]> {
    const rows = await this.db
      .selectFrom('topups')
      .selectAll()
      .where('status', '=', 'SUCCEEDED')
      .where('completed_at', '>=', sqlDate(from))
      .where('completed_at', '<', sqlDate(to))
      .orderBy('completed_at')
      .orderBy('id')
      .execute();
    return rows.map(rowToTopupView);
  }

  /** Bước 1: tìm ứng viên (đọc không khóa, có thể lệch tạm thời); bước 2: đọc lại có khóa để loại trừ lệch tạm thời. */
  async findUnbalancedTransactions(): Promise<Array<{ transactionId: string; total: number }>> {
    const result = await sql<{ transaction_id: string }>`
      select top (${sql.lit(LEDGER_CHECK_LIMIT)}) transaction_id
      from ${sql.id(this.schema, 'ledger_entries')}
      group by transaction_id
      having sum(amount) <> 0
      order by transaction_id`.execute(this.db);
    return this.confirmUnbalanced(result.rows.map((row) => row.transaction_id));
  }

  /** Cộng lại các dòng của riêng từng giao dịch ứng viên; chỉ giữ giao dịch vẫn lệch. */
  async confirmUnbalanced(
    transactionIds: readonly string[],
  ): Promise<Array<{ transactionId: string; total: number }>> {
    const confirmed: Array<{ transactionId: string; total: number }> = [];
    for (const transactionId of transactionIds) {
      const result = await sql<{ total: string | null }>`
        select sum(amount) as total from ${sql.id(this.schema, 'ledger_entries')}
        where transaction_id = ${transactionId}`.execute(this.db);
      const total = toSafeInteger(result.rows[0]?.total ?? '0');
      if (total !== 0) confirmed.push({ transactionId, total });
    }
    return confirmed;
  }

  async findBalanceMismatches(): Promise<
    Array<{ accountId: string; balance: number; ledgerTotal: number }>
  > {
    const result = await sql<{ id: string }>`
      select top (${sql.lit(LEDGER_CHECK_LIMIT)}) a.id
      from ${sql.id(this.schema, 'accounts')} a
      left join (
        select account_id, sum(amount) as total
        from ${sql.id(this.schema, 'ledger_entries')}
        group by account_id
      ) e on e.account_id = a.id
      where a.balance <> coalesce(e.total, 0)
      order by a.id`.execute(this.db);
    return this.confirmBalanceMismatches(result.rows.map((row) => row.id));
  }

  /**
   * Khóa hàng tài khoản (UPDLOCK, HOLDLOCK) rồi đọc lại số dư và tổng sổ cái của riêng nó: mọi giao dịch ghi sổ
   * đều cập nhật hàng này nên sau khi khóa, hai số liệu nhất quán thời điểm. Chỉ giữ tài khoản vẫn lệch.
   */
  async confirmBalanceMismatches(
    accountIds: readonly string[],
  ): Promise<Array<{ accountId: string; balance: number; ledgerTotal: number }>> {
    const confirmed: Array<{ accountId: string; balance: number; ledgerTotal: number }> = [];
    for (const accountId of accountIds) {
      const locked = await sql<{ balance: string }>`
        select balance from ${sql.id(this.schema, 'accounts')} with (updlock, holdlock)
        where id = ${accountId}`.execute(this.db);
      const row = locked.rows[0];
      if (row === undefined) continue;
      const sum = await sql<{ total: string | null }>`
        select sum(amount) as total from ${sql.id(this.schema, 'ledger_entries')}
        where account_id = ${accountId}`.execute(this.db);
      const balance = toSafeInteger(row.balance);
      const ledgerTotal = toSafeInteger(sum.rows[0]?.total ?? '0');
      if (balance !== ledgerTotal) confirmed.push({ accountId, balance, ledgerTotal });
    }
    return confirmed;
  }
}
