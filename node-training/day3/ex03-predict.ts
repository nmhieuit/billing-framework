// Bài 3 (Trung bình): ĐOÁN thứ tự (có thêm async/await).
// Ghi dự đoán các con số vào `answer`, ví dụ ['3', '1', ...], rồi chạy `pnpm test day3/ex03`.
// Mẹo: await xong thì phần code SAU await được xếp hàng chạy sau, giống .then.

// Giải thích đáp án:
//   3, 1, 6 : code đồng bộ (task() chạy đến await đầu tiên mới dừng)
//   2, 5    : microtask, theo thứ tự được xếp hàng (2 xếp trước 5)
//   4       : setTimeout là macrotask nên chạy sau cùng
export const answer: string[] = ['3', '1', '6', '2', '5', '4'];
