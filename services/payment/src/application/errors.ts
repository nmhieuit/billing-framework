/** Do `IdempotencyStore.save` ném khi khóa đã tồn tại (hai request đồng thời cùng key). */
export class DuplicateKeyError extends Error {
  override name = 'DuplicateKeyError';
}

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}

export class ChargeNotFoundError extends Error {
  override name = 'ChargeNotFoundError';
}

export class InvalidSettlementQueryError extends Error {
  override name = 'InvalidSettlementQueryError';
}
