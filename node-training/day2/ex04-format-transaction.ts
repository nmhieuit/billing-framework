// Bài 4 (Trung bình): destructuring + template string.
// formatTransaction({ id: 'a1', type: 'deposit', amount: 100 })  -> 'a1: +100'
// formatTransaction({ id: 'b2', type: 'withdraw', amount: 30 })  -> 'b2: -30'
import type { Transaction } from './transaction.js';

export function formatTransaction(tx: Transaction): string {
  // Destructuring: lấy 3 trường của tx ra thành 3 biến cùng tên
  const { id, type, amount } = tx;

  // Toán tử 3 ngôi: điều kiện ? giá trị nếu đúng : giá trị nếu sai
  const sign = type === 'deposit' ? '+' : '-';

  // Template string ghép các biến thành chuỗi
  return `${id}: ${sign}${amount}`;
}
