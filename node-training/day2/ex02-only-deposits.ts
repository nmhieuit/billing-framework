// Bài 2 (Cơ bản): filter.
// onlyDeposits(transactions) chỉ giữ lại các giao dịch có type === 'deposit'.

// "import type": chỉ import kiểu dữ liệu, dùng để TypeScript kiểm tra, không có mặt khi chạy
import type { Transaction } from './transaction.js';

export function onlyDeposits(transactions: Transaction[]): Transaction[] {
  // filter: giữ lại phần tử mà hàm trả về true, bỏ phần tử trả về false
  return transactions.filter(function (tx) {
    return tx.type === 'deposit';
  });
}
