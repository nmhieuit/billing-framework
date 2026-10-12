export type OpsActionKind = 'FREEZE' | 'UNFREEZE' | 'ADJUST' | 'REVERSE' | 'REPLAY_PAID';

export class InvalidOpsRequestError extends Error {
  override name = 'InvalidOpsRequestError';
}

export interface OpsRequestInput {
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

const MAX_ACTOR = 100;
const MAX_REASON = 500;
const MAX_IDEMPOTENCY_KEY = 200;

function field(name: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new InvalidOpsRequestError(`${name} must be 1..${max} characters`);
  }
  return trimmed;
}

/** Cắt khoảng trắng và kiểm tra độ dài của yêu cầu ops. */
export function validateOpsRequest(input: OpsRequestInput): OpsRequestInput {
  return {
    actor: field('actor', input.actor, MAX_ACTOR),
    reason: field('reason', input.reason, MAX_REASON),
    idempotencyKey: field('idempotencyKey', input.idempotencyKey, MAX_IDEMPOTENCY_KEY),
  };
}
