// Bài 8 (Nâng cao): tự viết test. Hàm dưới đây ĐÃ ĐÚNG, không sửa.
// applyDiscount(price, percent): giảm giá theo phần trăm, làm tròn thành số nguyên.
//   applyDiscount(1000, 10) -> 900. Kết quả có số lẻ thì làm tròn thế nào? Hãy chạy thử và quan sát.
//   percent ngoài khoảng 0..100 -> throw new Error('percent must be between 0 and 100')
export function applyDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new Error('percent must be between 0 and 100');
  }
  return Math.ceil(price - (price * percent) / 100);
}
