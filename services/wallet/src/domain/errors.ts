export class InvalidTenantError extends Error {
  override name = 'InvalidTenantError';
}

export class InvalidCustomerError extends Error {
  override name = 'InvalidCustomerError';
}

export class InvalidTopupError extends Error {
  override name = 'InvalidTopupError';
}

export class InvalidLedgerTransactionError extends Error {
  override name = 'InvalidLedgerTransactionError';
}

/** Ví không đủ số dư (số dư sau giao dịch sẽ âm). */
export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

/** Vi phạm bất biến sổ cái (ví dụ GATEWAY dương, khác đồng tiền). */
export class LedgerInvariantError extends Error {
  override name = 'LedgerInvariantError';
}

export class StateTransitionError extends Error {
  override name = 'StateTransitionError';
}

/** Đầu vào đối soát không hợp lệ (ngày, ghi chú, người xử lý, trạng thái đóng ca). */
export class InvalidReconciliationError extends Error {
  override name = 'InvalidReconciliationError';
}
