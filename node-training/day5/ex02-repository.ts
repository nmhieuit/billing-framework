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
  // TODO: #wallets = new Map<string, Wallet>() và 3 phương thức
  save(wallet: Wallet): void {
    void wallet;
  }

  findById(id: string): Wallet | undefined {
    void id;
    return undefined;
  }

  count(): number {
    return -1;
  }
}
