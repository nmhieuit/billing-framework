// Bài 3 (Trung bình): lớp service (nghiệp vụ) dùng repository được "tiêm" vào qua constructor.
//   withdraw(id, amount):
//     - amount không phải số nguyên dương -> throw new InvalidAmountError()
//     - ví không tồn tại                  -> throw new WalletNotFoundError(id)
//     - amount lớn hơn số dư              -> throw new InsufficientFundsError()   (message 'insufficient funds')
//     - ngược lại trừ tiền, lưu lại bằng repo.save và trả về ví mới
// Thứ tự kiểm tra: amount -> ví -> số dư.
import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import type { Wallet, WalletRepository } from './support/wallet-repository.js';

// Lỗi riêng: không đủ tiền
export class InsufficientFundsError extends Error {
  constructor() {
    // Gọi constructor của lớp cha (Error) để đặt nội dung thông báo
    super('insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class WithdrawService {
  // "private readonly repo" trong tham số: tự tạo trường this.repo.
  // Kho được truyền từ bên ngoài vào (dependency injection) nên dễ thay bằng kho giả khi test
  constructor(private readonly repo: WalletRepository) {}

  withdraw(id: string, amount: number): Wallet {
    // 1. Kiểm tra số tiền trước
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InvalidAmountError();
    }

    // 2. Tìm ví
    const wallet = this.repo.findById(id);
    if (wallet === undefined) {
      throw new WalletNotFoundError(id);
    }

    // 3. Kiểm tra số dư
    if (amount > wallet.balance) {
      throw new InsufficientFundsError();
    }

    // 4. Trừ tiền rồi lưu lại (kho trả về bản sao nên phải save mới có hiệu lực)
    wallet.balance = wallet.balance - amount;
    this.repo.save(wallet);
    return wallet;
  }
}
