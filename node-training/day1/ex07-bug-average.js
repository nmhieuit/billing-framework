// Bài 7 (Sửa lỗi): hàm tính trung bình đang trả về NaN.
// Chạy `pnpm test day1/ex07`, đọc thông báo lỗi, tìm và sửa lỗi (chỉ cần sửa 1 chỗ).
// average([2, 4, 6]) phải là 4; mảng rỗng phải trả về 0.
export function average(numbers) {
  if (numbers.length === 0) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i <= numbers.length; i++) {
    total = total + numbers[i];
  }
  return total / numbers.length;
}
