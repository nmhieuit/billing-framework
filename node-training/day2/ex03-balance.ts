// Bài 3 (Trung bình): reduce.
// balanceOf(transactions): deposit cộng, withdraw trừ.
// [{deposit 100}, {withdraw 30}, {deposit 5}] -> 75. Danh sách rỗng -> 0.
import type { Transaction } from './transaction.js';

export function balanceOf(transactions: Transaction[]): number {
  // reduce: gộp cả mảng thành MỘT giá trị.
  // "balance" là kết quả tích lũy qua từng bước, bắt đầu từ 0 (tham số thứ 2 của reduce)
  const result = transactions.reduce(function (balance, tx) {
    if (tx.type === 'deposit') {
      return balance + tx.amount; // nạp thì cộng
    }
    return balance - tx.amount; // rút thì trừ
  }, 0);

  return result;
}
