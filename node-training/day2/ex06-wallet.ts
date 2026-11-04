// Bài 6 (Nâng cao): class Wallet.
//   new Wallet('An')          -> owner = 'An', balance = 0
//   deposit(amount)           -> cộng tiền, trả về số dư mới
//   withdraw(amount)          -> trừ tiền, trả về số dư mới
//   Số tiền phải là số nguyên dương, nếu không: throw new Error('amount must be a positive integer')
//   Rút quá số dư:            throw new Error('insufficient funds') và số dư KHÔNG đổi
// Số dư lưu trong trường riêng, bên ngoài chỉ đọc qua `get balance()`.

export class Wallet {
  // "private": chỉ code bên trong class mới được đọc/sửa trường này
  // Tên có dấu _ phía trước là quy ước cho trường riêng
  private _balance: number = 0;

  // "readonly owner": tự tạo trường owner từ tham số, chỉ gán 1 lần, không sửa được nữa
  constructor(readonly owner: string) {}

  // getter: bên ngoài đọc wallet.balance như một thuộc tính, nhưng không thể gán đè
  get balance(): number {
    return this._balance;
  }

  // Nạp tiền, trả về số dư mới
  deposit(amount: number): number {
    this.checkAmount(amount);
    this._balance = this._balance + amount;
    return this._balance;
  }

  // Rút tiền, trả về số dư mới
  withdraw(amount: number): number {
    this.checkAmount(amount);
    // Kiểm tra TRƯỚC khi trừ để số dư không đổi khi báo lỗi
    if (amount > this._balance) {
      throw new Error('insufficient funds');
    }
    this._balance = this._balance - amount;
    return this._balance;
  }

  // Hàm phụ dùng chung cho deposit và withdraw: kiểm tra số tiền hợp lệ
  private checkAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer');
    }
  }
}
