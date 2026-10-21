// Bài 8 (Sửa lỗi): tổng đang ra 0.
// totalAmount(ids, loadAmount) phải cộng các số tiền tải về cho từng id (loadAmount là hàm async).
// Chạy `pnpm test day3/ex08`, đọc lỗi, và nghĩ: vì sao forEach + async không "chờ" như mong đợi?
export async function totalAmount(ids: string[], loadAmount: (id: string) => Promise<number>): Promise<number> {
  let total = 0;
  ids.forEach(async (id) => {
    total += await loadAmount(id);
  });
  return total;
}
