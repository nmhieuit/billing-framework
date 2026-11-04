// Đã viết sẵn cho các bài Ngày 5. Không cần sửa.

// Lỗi riêng: không tìm thấy ví.
// "extends Error": kế thừa lớp Error có sẵn của JavaScript, nên dùng được với throw / try-catch
export class WalletNotFoundError extends Error {
  // "readonly walletId" trong tham số: tự tạo trường walletId, chỉ gán 1 lần
  constructor(readonly walletId: string) {
    // super(...): gọi constructor của lớp cha (Error) để đặt nội dung thông báo lỗi
    super(`wallet not found: ${walletId}`);
    // name giúp phân biệt loại lỗi khi in ra
    this.name = 'WalletNotFoundError';
  }
}

// Lỗi riêng: số tiền không hợp lệ
export class InvalidAmountError extends Error {
  constructor() {
    super('amount must be a positive integer');
    this.name = 'InvalidAmountError';
  }
}
