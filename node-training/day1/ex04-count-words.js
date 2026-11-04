// Bài 4 (Trung bình): đếm số từ trong câu.
// countWords('xin chào  Node') -> 3   (nhiều dấu cách liền nhau vẫn tính đúng)
// countWords('') -> 0

export function countWords(text) {
  // split(' ') cắt chuỗi tại mỗi dấu cách thành một mảng.
  // Ví dụ 'a  b'.split(' ') -> ['a', '', 'b'] (2 dấu cách liền nhau sinh ra phần tử rỗng)
  const words = text.split(' ');

  let count = 0;
  for (const word of words) {
    // Bỏ qua phần tử rỗng, chỉ đếm từ thật
    if (word !== '') {
      count = count + 1;
    }
  }
  return count;
}
