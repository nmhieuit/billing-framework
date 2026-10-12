import { createHash } from 'node:crypto';
import { validateOpsRequest, type OpsActionKind } from '../domain/ops.js';
import type { TenantId } from '../domain/tenant-id.js';
import { DuplicateKeyError, OpsIdempotencyConflictError } from './errors.js';
import type {
  Clock,
  IdGenerator,
  Logger,
  Metrics,
  Repositories,
  TenantUnitOfWork,
} from './ports.js';

export interface OpsRequest {
  actor: string;
  reason: string;
  idempotencyKey: string;
}

export interface OpsRun<T> {
  result: T;
  replayed: boolean;
}

interface RunInput<T> {
  tenant: TenantId;
  action: OpsActionKind;
  request: OpsRequest;
  target: string;
  params: object;
  work: (ctx: {
    repositories: Repositories;
    actionId: string;
    now: Date;
  }) => Promise<{ result: T; record: boolean }>;
}

/**
 * Chạy một thao tác vận hành trong MỘT transaction cùng với bản ghi kiểm toán `ops_actions`.
 * Khóa idempotency + dấu vân tay của yêu cầu: gọi lại cùng khóa/cùng nội dung trả lại kết quả cũ, khác nội dung thì từ chối.
 */
export class OpsActionRecorder {
  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      clock: Clock;
      ids: IdGenerator;
      log: Logger;
      metrics: Metrics;
    },
  ) {}

  async run<T extends object>(input: RunInput<T>): Promise<OpsRun<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        // Validate nằm trong try để đầu vào sai cũng được đếm là `rejected`.
        const request = validateOpsRequest({
          actor: input.request.actor,
          reason: input.request.reason,
          idempotencyKey: input.request.idempotencyKey,
        });
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify({ action: input.action, target: input.target, params: input.params }),
          )
          .digest('hex');
        const outcome = await this.deps.uow.run(input.tenant, async (repositories) => {
          const existing = await repositories.ops.find(request.idempotencyKey);
          if (existing) {
            if (existing.fingerprint !== fingerprint) {
              throw new OpsIdempotencyConflictError(
                'idempotency key reused with a different request',
              );
            }
            return { result: JSON.parse(existing.result) as T, replayed: true, recorded: false };
          }
          const now = this.deps.clock.now();
          const actionId = this.deps.ids.eventId();
          const done = await input.work({ repositories, actionId, now });
          if (done.record) {
            await repositories.ops.insert({
              id: actionId,
              action: input.action,
              actor: request.actor,
              reason: request.reason,
              target: input.target,
              idempotencyKey: request.idempotencyKey,
              fingerprint,
              result: JSON.stringify(done.result),
              createdAt: now,
            });
          }
          return { result: done.result, replayed: false, recorded: done.record };
        });
        this.deps.metrics.opsAction(
          input.tenant.value,
          input.action,
          outcome.recorded ? 'ok' : 'noop',
        );
        if (outcome.recorded) {
          this.deps.log.info(
            {
              tenantId: input.tenant.value,
              action: input.action,
              actor: request.actor,
              target: input.target,
            },
            'ops action recorded',
          );
        }
        return { result: outcome.result, replayed: outcome.replayed };
      } catch (error) {
        // Hai yêu cầu cùng khóa đua nhau: bên thua vấp khóa duy nhất của ops_actions và rollback; chạy lại một lần sẽ phát lại kết quả của bên thắng.
        if (error instanceof DuplicateKeyError && error.source === 'ops_action' && attempt < 1) {
          continue;
        }
        this.deps.metrics.opsAction(input.tenant.value, input.action, 'rejected');
        throw error;
      }
    }
  }
}
