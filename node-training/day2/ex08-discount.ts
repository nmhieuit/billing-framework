// Bài 8 (Nâng cao): tự viết test. Hàm dưới đây ĐÃ ĐÚNG, không sửa.
// applyDiscount(price, percent): giảm giá theo phần trăm, làm tròn thành số nguyên.
//   applyDiscount(1000, 10) -> 900.
//   percent ngoài khoảng 0..100 -> throw new Error('percent must be between 0 and 100')

export function applyDiscount(price: number, percent: number): number {
  // Phần trăm phải nằm trong khoảng 0..100
  if (percent < 0 || percent > 100) {
    throw new Error('percent must be between 0 and 100');
  }
  // Giá sau giảm = giá - (giá * percent / 100)
  const discounted = price - (price * percent) / 100;
  // Math.ceil: làm tròn LÊN (ví dụ 499.5 -> 500)
  return Math.ceil(discounted);
}
