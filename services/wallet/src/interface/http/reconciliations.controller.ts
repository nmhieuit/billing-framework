import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InvalidQueryError } from '../../application/errors.js';
import type { GetReconciliationRun } from '../../application/get-reconciliation-run.js';
import type { ListReconciliationItems } from '../../application/list-reconciliation-items.js';
import type { ResolveReconciliationItem } from '../../application/resolve-reconciliation-item.js';
import type { StartManualReconciliation } from '../../application/start-manual-reconciliation.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { ApiError } from './errors.js';
import { CurrentTenant, TenantGuard } from './tenant.guard.js';
import {
  GET_RECONCILIATION_RUN,
  LIST_RECONCILIATION_ITEMS,
  RESOLVE_RECONCILIATION_ITEM,
  START_RECONCILIATION,
} from './tokens.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Trường không phải chuỗi coi như rỗng để use case từ chối bằng 422 (không phải 400). */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

@Controller()
@UseGuards(TenantGuard)
export class ReconciliationsController {
  constructor(
    @Inject(START_RECONCILIATION)
    private readonly start: Pick<StartManualReconciliation, 'execute'>,
    @Inject(GET_RECONCILIATION_RUN) private readonly getRun: Pick<GetReconciliationRun, 'execute'>,
    @Inject(LIST_RECONCILIATION_ITEMS)
    private readonly listItems: Pick<ListReconciliationItems, 'execute'>,
    @Inject(RESOLVE_RECONCILIATION_ITEM)
    private readonly resolve: Pick<ResolveReconciliationItem, 'execute'>,
  ) {}

  @Post('reconciliations')
  @HttpCode(202)
  create(@CurrentTenant() tenant: TenantId, @Body() body: unknown) {
    return this.start.execute({ tenant, day: text(bodyObject(body).date) });
  }

  @Get('reconciliations/:runId')
  get(@CurrentTenant() tenant: TenantId, @Param('runId') runId: string) {
    return this.getRun.execute({ tenant, runId });
  }

  @Get('reconciliations/:runId/items')
  items(
    @CurrentTenant() tenant: TenantId,
    @Param('runId') runId: string,
    @Query('caseStatus') caseStatus?: string | string[],
    @Query('limit') limit?: string | string[],
    @Query('cursor') cursor?: string | string[],
  ) {
    if (Array.isArray(caseStatus) || Array.isArray(limit) || Array.isArray(cursor)) {
      throw new InvalidQueryError('caseStatus, limit and cursor must each be given at most once');
    }
    return this.listItems.execute({
      tenant,
      runId,
      caseStatus,
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
    });
  }

  @Post('reconciliation-items/:id/resolve')
  @HttpCode(200)
  close(@CurrentTenant() tenant: TenantId, @Param('id') id: string, @Body() body: unknown) {
    const fields = bodyObject(body);
    return this.resolve.execute({
      tenant,
      itemId: id,
      status: text(fields.status),
      note: text(fields.note),
      resolvedBy: text(fields.resolvedBy),
    });
  }
}
