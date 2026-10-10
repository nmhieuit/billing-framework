export class MissingTenantError extends Error {
  override name = 'MissingTenantError';
}

export class UnknownTenantError extends Error {
  override name = 'UnknownTenantError';
}

export class MissingCustomerError extends Error {
  override name = 'MissingCustomerError';
}

export class WalletNotFoundError extends Error {
  override name = 'WalletNotFoundError';
}

export class WalletCurrencyConflictError extends Error {
  override name = 'WalletCurrencyConflictError';
}

export class TopupNotFoundError extends Error {
  override name = 'TopupNotFoundError';
}

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}

export class InvalidQueryError extends Error {
  override name = 'InvalidQueryError';
}

/** Do repository ném khi vi phạm khóa duy nhất (idempotency key, business key, inbox, ví trùng). */
export class DuplicateKeyError extends Error {
  override name = 'DuplicateKeyError';

  /** Nơi phát sinh trùng khóa, để use case phân biệt (vd. inbox: bình thường; sổ cái: bất thường). */
  constructor(
    message: string,
    readonly source?: 'inbox' | 'ledger' | 'order_payment',
  ) {
    super(message);
  }
}
