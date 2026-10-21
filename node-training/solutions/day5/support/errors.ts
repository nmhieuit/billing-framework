// Đã viết sẵn cho các bài Ngày 5. Không cần sửa.
export class WalletNotFoundError extends Error {
  constructor(readonly walletId: string) {
    super(`wallet not found: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class InvalidAmountError extends Error {
  constructor() {
    super('amount must be a positive integer');
    this.name = 'InvalidAmountError';
  }
}
