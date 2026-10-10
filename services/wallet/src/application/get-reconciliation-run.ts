import type { TenantId } from '../domain/tenant-id.js';
import { ReconciliationNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toRunView, type ReconciliationRunView } from './reconciliation-views.js';

export class GetReconciliationRun {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: { tenant: TenantId; runId: string }): Promise<ReconciliationRunView> {
    const run = await this.deps.uow.run(input.tenant, ({ reconciliation }) =>
      reconciliation.findRun(input.runId),
    );
    if (run === null)
      throw new ReconciliationNotFoundError(`reconciliation run ${input.runId} not found`);
    return toRunView(run);
  }
}
