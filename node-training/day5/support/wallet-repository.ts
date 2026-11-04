// Đã viết sẵn cho các bài Ngày 5. Không cần sửa.

// Hình dạng của một ví
export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

// "Hợp đồng" của kho lưu ví: kho nào cũng phải có 2 hàm này.
// Service chỉ phụ thuộc vào interface, nên sau này có thể đổi sang kho khác (ví dụ database) mà không sửa service
export interface WalletRepository {
  save(wallet: Wallet): void;
  findById(id: string): Wallet | undefined;
}

// Kho lưu ví trong bộ nhớ, thực hiện (implements) đúng hợp đồng WalletRepository
export class InMemoryWalletRepository implements WalletRepository {
  // private readonly: chỉ dùng bên trong class, và không gán lại biến này được
  private readonly wallets = new Map<string, Wallet>();

  save(wallet: Wallet): void {
    // { ...wallet }: sao chép đối tượng, để sửa bên ngoài không làm đổi dữ liệu trong kho
    this.wallets.set(wallet.id, { ...wallet });
  }

  findById(id: string): Wallet | undefined {
    const found = this.wallets.get(id);
    if (found === undefined) {
      return undefined;
    }
    // Trả về bản sao, không trả về đối tượng gốc trong kho
    return { ...found };
  }
}
