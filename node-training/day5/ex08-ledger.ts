// Bài 8 (Nâng cao, tùy chọn): sổ cái (ledger) ghi sổ kép tối giản — cùng ý tưởng với dự án thật.
// Mỗi lần ghi (post) gồm một `reference` (mã duy nhất, ví dụ 'topup:t1') và nhiều dòng { account, amount }.
// Quy tắc:
//   - Tổng amount của các dòng phải bằng 0 (tiền đi từ đâu thì đến đó). Sai -> throw new Error('entries must balance')
//   - reference đã tồn tại -> throw new Error('duplicate reference: <reference>')  (giống ràng buộc UNIQUE)
//   - Phải có ít nhất 2 dòng. Ít hơn -> throw new Error('at least two entries required')
//   - Nếu ghi bị từ chối thì KHÔNG dòng nào được lưu.
// balanceOf(account): tổng amount của account (chưa từng xuất hiện -> 0).
export interface Entry {
  account: string;
  amount: number;
}

export class Ledger {
  // TODO
  post(reference: string, entries: Entry[]): void {
    void reference;
    void entries;
  }

  balanceOf(account: string): number {
    void account;
    return NaN;
  }
}
