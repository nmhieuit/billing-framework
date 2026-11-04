// Bài 8 (Nâng cao, tùy chọn): sổ cái (ledger) ghi sổ kép tối giản — cùng ý tưởng với dự án thật.
// Mỗi lần ghi (post) gồm một `reference` (mã duy nhất, ví dụ 'topup:t1') và nhiều dòng { account, amount }.
// Quy tắc:
//   - Tổng amount của các dòng phải bằng 0 (tiền đi từ đâu thì đến đó). Sai -> throw new Error('entries must balance')
//   - reference đã tồn tại -> throw new Error('duplicate reference: <reference>')  (giống ràng buộc UNIQUE)
//   - Phải có ít nhất 2 dòng. Ít hơn -> throw new Error('at least two entries required')
//   - Nếu ghi bị từ chối thì KHÔNG dòng nào được lưu.
// balanceOf(account): tổng amount của account (chưa từng xuất hiện -> 0).

// Một dòng ghi sổ: tài khoản nào, thay đổi bao nhiêu (dương = nhận, âm = chi)
export interface Entry {
  account: string;
  amount: number;
}

export class Ledger {
  // reference -> danh sách dòng của lần ghi đó
  private readonly postings = new Map<string, Entry[]>();

  post(reference: string, entries: Entry[]): void {
    // Kiểm tra TẤT CẢ điều kiện trước, rồi mới lưu -> bị từ chối thì không lưu gì

    // 1. reference không được trùng
    if (this.postings.has(reference)) {
      throw new Error(`duplicate reference: ${reference}`);
    }

    // 2. Cần ít nhất 2 dòng (một bên chi, một bên nhận)
    if (entries.length < 2) {
      throw new Error('at least two entries required');
    }

    // 3. Tổng các dòng phải bằng 0
    let total = 0;
    for (const entry of entries) {
      total = total + entry.amount;
    }
    if (total !== 0) {
      throw new Error('entries must balance');
    }

    // Hợp lệ hết: lưu lại
    this.postings.set(reference, entries);
  }

  // Số dư của một tài khoản = cộng amount của mọi dòng thuộc tài khoản đó
  balanceOf(account: string): number {
    let total = 0;
    // values(): duyệt qua các danh sách dòng đã lưu
    for (const entries of this.postings.values()) {
      for (const entry of entries) {
        if (entry.account === account) {
          total = total + entry.amount;
        }
      }
    }
    return total;
  }
}
