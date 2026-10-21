// Bài 5 (Trung bình): ghép nhiều bước (filter + map + reduce) và module.
// summarize(transactions) -> { count, totalDeposited, ids }
//   count          = số giao dịch nạp tiền
//   totalDeposited = tổng tiền các giao dịch nạp
//   ids            = mảng id của các giao dịch nạp (giữ thứ tự)
// Hãy tái sử dụng onlyDeposits từ bài 2 bằng import (đã import sẵn bên dưới).
import { onlyDeposits } from './ex02-only-deposits.js';
import type { Transaction } from './transaction.js';

export interface Summary {
  count: number;
  totalDeposited: number;
  ids: string[];
}

export function summarize(transactions: Transaction[]): Summary {
  // TODO
  void onlyDeposits;
  return { count: -1, totalDeposited: -1, ids: [] };
}
