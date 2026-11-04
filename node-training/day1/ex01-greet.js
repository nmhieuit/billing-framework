// Bài 1 (Cơ bản): trả về lời chào.
// greet('An') phải trả về 'Xin chào, An!'

// "export" cho phép file khác (ví dụ file test) import hàm này để dùng
export function greet(name) {
  // Template string: viết trong dấu huyền và chèn biến bằng ${...}
  return `Xin chào, ${name}!`;
}

// In thử ra màn hình khi chạy trực tiếp: node ex01-greet.js
console.log(greet('An'));
