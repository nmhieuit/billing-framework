// Bài 5 (Trung bình): ghép nhiều bước (filter + map + reduce) và module.
// summarize(transactions) -> { count, totalDeposited, ids }
//   count          = số giao dịch nạp tiền
//   totalDeposited = tổng tiền các giao dịch nạp
//   ids            = mảng id của các giao dịch nạp (giữ thứ tự)

// Tái sử dụng hàm của bài 2 bằng cách import
import { onlyDeposits } from './ex02-only-deposits.js';
import type { Transaction } from './transaction.js';

// Kiểu của kết quả trả về
export interface Summary {
  count: number;
  totalDeposited: number;
  ids: string[];
}

export function summarize(transactions: Transaction[]): Summary {
  // Bước 1: lọc ra các giao dịch nạp
  const deposits = onlyDeposits(transactions);

  // Bước 2: đếm số lượng
  const count = deposits.length;

  // Bước 3: cộng dồn số tiền (reduce, bắt đầu từ 0)
  const totalDeposited = deposits.reduce(function (sum, tx) {
    return sum + tx.amount;
  }, 0);

  // Bước 4: lấy danh sách id (map: mỗi giao dịch -> id của nó)
  const ids = deposits.map(function (tx) {
    return tx.id;
  });

  // Tên biến trùng tên trường nên viết gọn { count } thay cho { count: count }
  return { count, totalDeposited, ids };
}
