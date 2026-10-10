import type { TenantId } from '../domain/tenant-id.js';
import type { BackgroundRuns } from './background-runs.js';
import type { RunReconciliation } from './run-reconciliation.js';

/** `POST /reconciliations`: tạo lượt ngay (để trả `runId`), phần còn lại chạy nền. */
export class StartManualReconciliation {
  constructor(
    private readonly deps: {
      run: Pick<RunReconciliation, 'begin' | 'finish'>;
      background: Pick<BackgroundRuns, 'submit'>;
    },
  ) {}

  async execute(input: {
    tenant: TenantId;
    day: string;
  }): Promise<{ runId: string; status: 'RUNNING' }> {
    const handle = await this.deps.run.begin({
      tenant: input.tenant,
      day: input.day,
      triggeredBy: 'MANUAL',
    });
    if (handle === null) throw new Error('a manual reconciliation run must always be created');
    this.deps.background.submit({ tenantId: input.tenant.value, runId: handle.runId }, () =>
      this.deps.run.finish(handle),
    );
    return { runId: handle.runId, status: 'RUNNING' };
  }
}
