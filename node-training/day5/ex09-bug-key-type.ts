// Bài 9 (Sửa lỗi): ví có trong kho nhưng tìm không ra.
// Nguyên nhân gốc: khóa trong Map là SỐ (1, 2) nhưng id lấy từ URL luôn là CHUỖI ('1'),
// mà Map phân biệt 1 và '1' nên get('1') không tìm thấy.
// Bản sửa: đổi chuỗi sang số bằng Number(id) trước khi tìm.

export function findWalletOwner(id: string): string | undefined {
  // Khóa là số, giá trị là tên chủ ví
  const wallets = new Map<number, string>([
    [1, 'An'],
    [2, 'Bình'],
  ]);

  // Number('abc') ra NaN, không khớp khóa nào nên get trả về undefined
  return wallets.get(Number(id));
}
