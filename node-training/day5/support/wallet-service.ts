// Đã viết sẵn cho các bài Ngày 5. Không cần sửa.
import { InvalidAmountError, WalletNotFoundError } from './errors.js';
import type { Wallet, WalletRepository } from './wallet-repository.js';

// Service chứa logic nghiệp vụ (quy tắc nạp tiền, mở ví, ...), không biết gì về HTTP
export class WalletService {
  // Kho lưu ví được "tiêm" (truyền) vào từ bên ngoài qua constructor
  constructor(private readonly repo: WalletRepository) {}

  // Mở ví mới cho một chủ ví, id có dạng w-<tên viết thường>
  open(owner: string): Wallet {
    const wallet: Wallet = { id: 'w-' + owner.toLowerCase(), owner, balance: 0 };
    this.repo.save(wallet);
    return wallet;
  }

  // Nạp tiền vào ví, trả về ví đã cập nhật
  deposit(id: string, amount: number): Wallet {
    // 1. Kiểm tra số tiền
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InvalidAmountError();
    }
    // 2. Tìm ví
    const wallet = this.repo.findById(id);
    if (wallet === undefined) {
      throw new WalletNotFoundError(id);
    }
    // 3. Cộng tiền rồi lưu lại (vì kho trả về bản sao nên phải save)
    wallet.balance = wallet.balance + amount;
    this.repo.save(wallet);
    return wallet;
  }

  // Lấy ví theo id
  get(id: string): Wallet {
    const wallet = this.repo.findById(id);
    if (wallet === undefined) {
      throw new WalletNotFoundError(id);
    }
    return wallet;
  }
}
