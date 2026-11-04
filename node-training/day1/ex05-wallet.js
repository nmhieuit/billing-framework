// Bài 5 (Trung bình): đối tượng ví.
// createWallet('An') -> { owner: 'An', balance: 0 }
// deposit(wallet, 100): cộng 100 vào wallet.balance và trả về số dư mới.
//   Nếu amount không phải số nguyên dương -> throw new Error('amount must be a positive integer')

// Tạo ví mới với số dư ban đầu bằng 0
export function createWallet(owner) {
  // { owner } là cách viết gọn của { owner: owner }
  return { owner, balance: 0 };
}

// Nạp tiền vào ví, trả về số dư mới
export function deposit(wallet, amount) {
  // Number.isInteger(x): x có phải số nguyên không (1.5 hoặc '5' thì không)
  // Không phải số nguyên, hoặc nhỏ hơn hay bằng 0 -> báo lỗi
  if (!Number.isInteger(amount) || amount <= 0) {
    // throw: dừng hàm và ném lỗi ra cho nơi gọi xử lý
    throw new Error('amount must be a positive integer');
  }
  // Đối tượng truyền vào hàm là tham chiếu, nên sửa ở đây sẽ đổi luôn ví gốc
  wallet.balance = wallet.balance + amount;
  return wallet.balance;
}
