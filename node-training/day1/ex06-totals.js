// Bài 6 (Nâng cao): tổng hợp danh sách giao dịch.
// totalsByType([{ type: 'deposit', amount: 100 }, { type: 'withdraw', amount: 30 }, { type: 'deposit', amount: 50 }])
//   -> { deposit: 150, withdraw: 30 }
// Danh sách rỗng -> {}.

export function totalsByType(transactions) {
  // Đối tượng rỗng để chứa kết quả, khóa là loại giao dịch
  const totals = {};

  for (const tx of transactions) {
    // totals[tx.type]: đọc/ghi khóa có tên lấy từ biến.
    // Khóa chưa có thì giá trị là undefined
    if (totals[tx.type] === undefined) {
      // Lần đầu gặp loại này: khởi tạo bằng 0
      totals[tx.type] = 0;
    }
    // Cộng số tiền vào tổng của loại đó
    totals[tx.type] = totals[tx.type] + tx.amount;
  }

  return totals;
}
