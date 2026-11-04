// Kiểu dùng chung cho các bài Ngày 2. Không cần sửa file này.

// interface: mô tả "hình dạng" của một đối tượng (có những trường nào, kiểu gì)
export interface Transaction {
  id: string; // mã giao dịch
  type: 'deposit' | 'withdraw'; // chỉ được là 1 trong 2 chuỗi này: nạp hoặc rút
  amount: number; // số tiền
}
