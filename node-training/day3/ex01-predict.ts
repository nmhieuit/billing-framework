// Bài 1 (Cơ bản): ĐOÁN trước khi chạy.
// Đọc ex01-scenario.ts, ghi dự đoán thứ tự các chữ cái được ghi vào mảng `answer`
// (ví dụ ['A', 'B', ...]). Sau đó chạy `pnpm test day3/ex01` để xem bạn đoán đúng không.
// Quy tắc: đoán xong rồi mới chạy. Đoán sai thì đọc lại phần "microtask" trong bài học.

// Giải thích đáp án:
//   A, D : code đồng bộ chạy trước
//   C    : microtask (Promise.then) chạy ngay sau code đồng bộ
//   B    : macrotask (setTimeout) chạy sau cùng
export const answer: string[] = ['A', 'D', 'C', 'B'];
