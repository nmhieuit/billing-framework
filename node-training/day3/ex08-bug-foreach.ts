// Bài 8 (Sửa lỗi): tổng đang ra 0.
// totalAmount(ids, loadAmount) phải cộng các số tiền tải về cho từng id (loadAmount là hàm async).
// Lỗi gốc: dùng forEach(async ...) - forEach không chờ Promise nên hàm trả về total khi còn là 0.
// Bản sửa: dùng for...of + await để chờ từng lần tải xong.

export async function totalAmount(ids: string[], loadAmount: (id: string) => Promise<number>): Promise<number> {
  let total = 0;
  for (const id of ids) {
    // await: chờ tải xong số tiền của id này rồi mới cộng
    const amount = await loadAmount(id);
    total = total + amount;
  }
  return total;
}
