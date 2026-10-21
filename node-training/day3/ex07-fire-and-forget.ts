// Bài 7 (Nâng cao): chạy nền an toàn ("fire and forget").
// runInBackground(task, onError):
//   - gọi task() NGAY, nhưng KHÔNG chờ nó xong: hàm trả về (void) ngay lập tức.
//   - nếu task thất bại (reject), gọi onError(error) thay vì để lỗi "rơi" ra ngoài (unhandled rejection).
//   - nếu task ném lỗi đồng bộ ngay dòng đầu (không phải Promise), cũng phải gọi onError.
// Gợi ý: bọc trong một hàm async nhỏ rồi gắn .catch(onError).
export function runInBackground(task: () => Promise<void>, onError: (error: unknown) => void): void {
  // TODO
  void task;
  void onError;
}
