import { validateResolution } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import { ReconciliationConflictError, ReconciliationItemNotFoundError } from './errors.js';
import type { Clock, TenantUnitOfWork } from './ports.js';
import { toItemView, type ReconciliationItemView } from './reconciliation-views.js';

/** Đóng một ca lệch bằng ghi chú và người xử lý. Không sửa sổ cái; lặp lại cùng giá trị thì trả cùng kết quả. */
export class ResolveReconciliationItem {
  constructor(private readonly deps: { uow: TenantUnitOfWork; clock: Clock }) {}

  async execute(input: {
    tenant: TenantId;
    itemId: string;
    status: string;
    note: string;
    resolvedBy: string;
  }): Promise<ReconciliationItemView> {
    const resolution = validateResolution(input);
    const now = this.deps.clock.now();
    return this.deps.uow.run(input.tenant, async ({ reconciliation }) => {
      const item = await reconciliation.lockItem(input.itemId);
      if (item === null) {
        throw new ReconciliationItemNotFoundError(`reconciliation item ${input.itemId} not found`);
      }
      if (item.caseStatus === 'OPEN') {
        await reconciliation.resolveItem(item.id, { ...resolution, at: now });
        return toItemView({
          ...item,
          caseStatus: resolution.status,
          resolvedBy: resolution.resolvedBy,
          resolutionNote: resolution.note,
          resolvedAt: now,
        });
      }
      const same =
        item.caseStatus === resolution.status &&
        item.resolvedBy === resolution.resolvedBy &&
        item.resolutionNote === resolution.note;
      if (same) return toItemView(item);
      throw new ReconciliationConflictError(`item ${item.id} is already ${item.caseStatus}`);
    });
  }
}
