import type { CaseStatus } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import { InvalidQueryError, ReconciliationNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toItemView, type ReconciliationItemView } from './reconciliation-views.js';

export const DEFAULT_ITEM_LIMIT = 100;
export const MAX_ITEM_LIMIT = 500;
const CASE_STATUSES: readonly string[] = ['OPEN', 'RESOLVED', 'IGNORED'];

export class ListReconciliationItems {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: {
    tenant: TenantId;
    runId: string;
    caseStatus?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<{ items: ReconciliationItemView[]; nextCursor: string | null }> {
    const limit = input.limit ?? DEFAULT_ITEM_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEM_LIMIT) {
      throw new InvalidQueryError(`limit must be an integer in 1..${MAX_ITEM_LIMIT}`);
    }
    if (input.cursor !== undefined && !/^\d{1,15}$/.test(input.cursor)) {
      throw new InvalidQueryError('cursor is invalid');
    }
    if (input.caseStatus !== undefined && !CASE_STATUSES.includes(input.caseStatus)) {
      throw new InvalidQueryError('caseStatus must be OPEN, RESOLVED or IGNORED');
    }
    const afterSeq = input.cursor === undefined ? 0 : Number(input.cursor);
    const caseStatus = (input.caseStatus ?? null) as CaseStatus | null;

    const rows = await this.deps.uow.run(input.tenant, async ({ reconciliation }) => {
      if ((await reconciliation.findRun(input.runId)) === null) return null;
      // Đọc dư một dòng để biết còn trang sau hay không.
      return reconciliation.listItems({
        runId: input.runId,
        caseStatus,
        afterSeq,
        limit: limit + 1,
      });
    });
    if (rows === null)
      throw new ReconciliationNotFoundError(`reconciliation run ${input.runId} not found`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toItemView),
      nextCursor: rows.length > limit && last ? String(last.seq) : null,
    };
  }
}
