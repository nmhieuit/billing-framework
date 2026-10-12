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
    readonly source?: 'inbox' | 'ledger' | 'order_payment' | 'ops_action',
  ) {
    super(message);
  }
}

/** Không đọc được sao kê từ payment (mạng, HTTP lỗi, phản hồi sai dạng). */
export class SettlementUnavailableError extends Error {
  override name = 'SettlementUnavailableError';
}

/** Sao kê hoặc số dòng lệch vượt `RECONCILE_MAX_ITEMS`. */
export class ReconciliationTooLargeError extends Error {
  override name = 'ReconciliationTooLargeError';
}

export class ReconciliationNotFoundError extends Error {
  override name = 'ReconciliationNotFoundError';
}

export class ReconciliationItemNotFoundError extends Error {
  override name = 'ReconciliationItemNotFoundError';
}

/** Ca đã được đóng với giá trị khác. */
export class ReconciliationConflictError extends Error {
  override name = 'ReconciliationConflictError';
}

/** Khóa idempotency của thao tác vận hành đã dùng cho một yêu cầu khác. */
export class OpsIdempotencyConflictError extends Error {
  override name = 'OpsIdempotencyConflictError';
}

export class TransactionNotFoundError extends Error {
  override name = 'TransactionNotFoundError';
}

export class OrderNotFoundError extends Error {
  override name = 'OrderNotFoundError';
}

/** Giao dịch đã bị đảo trước đó. */
export class AlreadyReversedError extends Error {
  override name = 'AlreadyReversedError';
}

/** Loại giao dịch này không cho phép đảo. */
export class ReversalNotSupportedError extends Error {
  override name = 'ReversalNotSupportedError';
}

/** Không thể đảo vì số dư các tài khoản hiện tại không cho phép. */
export class ReversalNotPossibleError extends Error {
  override name = 'ReversalNotPossibleError';
}

/** Đơn gắn với giao dịch đã bị đảo. */
export class OrderReversedError extends Error {
  override name = 'OrderReversedError';
}

export class EventIdUnknownError extends Error {
  override name = 'EventIdUnknownError';
}
