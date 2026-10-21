// Bài 9 (Sửa lỗi): ví có trong kho nhưng tìm không ra.
// Chạy `pnpm test day5/ex09`. Mẹo: console.log(typeof id) và console.log([...wallets.keys()]).
// Gợi ý nhỏ: giá trị lấy từ đường dẫn URL (như /wallets/1) luôn là CHUỖI.
export function findWalletOwner(id: string): string | undefined {
  const wallets = new Map<number, string>([
    [1, 'An'],
    [2, 'Bình'],
  ]);
  return wallets.get(id as unknown as number);
}
