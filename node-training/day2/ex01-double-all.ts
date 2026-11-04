// Bài 1 (Cơ bản): map.
// doubleAll([1, 2, 3]) -> [2, 4, 6]. Không dùng vòng lặp for, dùng numbers.map(...).

// ": number[]" sau tham số là kiểu mảng số; ": number[]" sau dấu ) là kiểu giá trị trả về
export function doubleAll(numbers: number[]): number[] {
  // map: chạy hàm cho từng phần tử và gom kết quả thành MỘT MẢNG MỚI (mảng gốc không đổi)
  return numbers.map(function (n) {
    return n * 2;
  });
}
