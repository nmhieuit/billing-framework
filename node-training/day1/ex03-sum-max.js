// Bài 3 (Cơ bản): duyệt mảng bằng vòng lặp for...of.
// sum([1, 2, 3]) -> 6        (mảng rỗng -> 0)
// max([4, 9, 2]) -> 9        (mảng rỗng -> undefined)

// Tính tổng các số trong mảng
export function sum(numbers) {
  // Bắt đầu từ 0 rồi cộng dồn từng phần tử
  let total = 0;
  // for...of: lấy lần lượt từng phần tử của mảng ra biến "number"
  for (const number of numbers) {
    total = total + number;
  }
  // Mảng rỗng thì vòng lặp không chạy, total vẫn là 0
  return total;
}

// Tìm số lớn nhất trong mảng
export function max(numbers) {
  // Mảng rỗng thì không có số lớn nhất -> trả về undefined
  if (numbers.length === 0) {
    return undefined;
  }
  // Tạm coi phần tử đầu tiên là lớn nhất
  let maxValue = numbers[0];
  // Gặp số nào lớn hơn thì cập nhật
  for (const number of numbers) {
    if (number > maxValue) {
      maxValue = number;
    }
  }
  return maxValue;
}
