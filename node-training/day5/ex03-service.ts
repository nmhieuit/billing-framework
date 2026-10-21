// Bài 3 (Trung bình): lớp service (nghiệp vụ) dùng repository được "tiêm" vào qua constructor.
//   withdraw(id, amount):
//     - amount không phải số nguyên dương -> throw new InvalidAmountError()
//     - ví không tồn tại                  -> throw new WalletNotFoundError(id)
//     - amount lớn hơn số dư              -> throw new InsufficientFundsError()   (lớp này viết ngay trong file, message 'insufficient funds')
//     - ngược lại trừ tiền, lưu lại bằng repo.save và trả về ví mới
// Thứ tự kiểm tra: amount -> ví -> số dư.
import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import type { Wallet, WalletRepository } from './support/wallet-repository.js';

export class InsufficientFundsError extends Error {
  // TODO: constructor gọi super('insufficient funds')
}

export class WithdrawService {
  constructor(private readonly repo: WalletRepository) {}

  withdraw(id: string, amount: number): Wallet {
    // TODO
    void id;
    void amount;
    void InvalidAmountError;
    void WalletNotFoundError;
    throw new Error('TODO');
  }
}
