// Kiểu dùng chung cho các bài Ngày 2. Không cần sửa file này.
export interface Transaction {
  id: string;
  type: 'deposit' | 'withdraw';
  amount: number;
}
