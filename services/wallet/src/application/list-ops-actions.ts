import type { TenantId } from '../domain/tenant-id.js';
import { InvalidQueryError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';

export const DEFAULT_OPS_ACTIONS_LIMIT = 50;
export const MAX_OPS_ACTIONS_LIMIT = 200;
const CURSOR = /^[1-9]\d{0,17}$/;

export interface ListOpsActionsInput {
  tenant: TenantId;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface OpsActionView {
  id: string;
  action: string;
  actor: string;
  reason: string;
  target: string;
  createdAt: string;
}

export interface ListOpsActionsResult {
  items: OpsActionView[];
  nextCursor: string | null;
}

/** Liệt kê nhật ký thao tác vận hành, mới nhất trước; không lộ khóa idempotency, dấu vân tay hay kết quả. */
export class ListOpsActions {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: ListOpsActionsInput): Promise<ListOpsActionsResult> {
    const limit = input.limit ?? DEFAULT_OPS_ACTIONS_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OPS_ACTIONS_LIMIT) {
      throw new InvalidQueryError(`limit must be an integer in 1..${MAX_OPS_ACTIONS_LIMIT}`);
    }
    let beforeSeq: number | null = null;
    if (input.cursor !== undefined) {
      if (!CURSOR.test(input.cursor)) throw new InvalidQueryError('cursor is invalid');
      beforeSeq = Number(input.cursor);
    }
    const records = await this.deps.uow.run(input.tenant, ({ ops }) =>
      ops.list({ limit, beforeSeq }),
    );
    const last = records.at(-1);
    return {
      items: records.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        reason: r.reason,
        target: r.target,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: records.length === limit && last?.seq !== undefined ? String(last.seq) : null,
    };
  }
}
