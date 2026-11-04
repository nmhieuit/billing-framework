// Bài 7 (Sửa lỗi): tính trung bình cộng.
// average([2, 4, 6]) phải là 4; mảng rỗng phải trả về 0.
// (Bản này đã sửa đúng. Lỗi gốc thường là quên khởi tạo total = 0 nên kết quả ra NaN.)

export function average(numbers) {
  // Mảng rỗng: trả về 0 để tránh chia cho 0
  if (numbers.length === 0) {
    return 0;
  }

  // total phải bắt đầu bằng 0. Nếu để undefined thì undefined + số = NaN
  let total = 0;
  // Vòng lặp for cổ điển: i chạy từ 0 đến độ dài mảng - 1
  for (let i = 0; i < numbers.length; i++) {
    total = total + numbers[i];
  }

  // Trung bình = tổng / số lượng phần tử
  return total / numbers.length;
}
