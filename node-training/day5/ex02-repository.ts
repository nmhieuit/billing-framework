// Bài 2 (Cơ bản): kho lưu ví trong bộ nhớ (repository).
//   save(wallet)  lưu ví theo id (ghi đè nếu id đã có)
//   findById(id)  trả về ví hoặc undefined
//   count()       số ví đang lưu
// QUAN TRỌNG: lưu và trả về BẢN SAO ({ ...wallet }). Sửa bản sao bên ngoài không được làm đổi dữ liệu trong kho.

export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export class WalletRepository {
  // Map lưu ví theo id. "private": bên ngoài class không truy cập trực tiếp được
  private readonly wallets = new Map<string, Wallet>();

  // Lưu ví (cùng id thì ghi đè)
  save(wallet: Wallet): void {
    // { ...wallet } tạo một bản sao: sau này người gọi sửa wallet gốc cũng không ảnh hưởng kho
    this.wallets.set(wallet.id, { ...wallet });
  }

  // Tìm ví theo id
  findById(id: string): Wallet | undefined {
    const found = this.wallets.get(id);
    if (found === undefined) {
      return undefined;
    }
    // Trả về bản sao để người gọi không sửa nhầm dữ liệu trong kho
    return { ...found };
  }

  // Đếm số ví đang lưu
  count(): number {
    return this.wallets.size;
  }
}
