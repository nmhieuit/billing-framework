// Bài 7 (Nâng cao): chạy nền an toàn ("fire and forget").
// runInBackground(task, onError):
//   - gọi task() NGAY, nhưng KHÔNG chờ nó xong: hàm trả về (void) ngay lập tức.
//   - nếu task thất bại (reject), gọi onError(error) thay vì để lỗi "rơi" ra ngoài (unhandled rejection).
//   - nếu task ném lỗi đồng bộ ngay dòng đầu (không phải Promise), cũng phải gọi onError.

export function runInBackground(task: () => Promise<void>, onError: (error: unknown) => void): void {
  // Hàm async nhỏ để bọc task: cả lỗi đồng bộ lẫn lỗi bất đồng bộ đều rơi vào catch
  async function runSafely() {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
  }

  // Gọi mà KHÔNG await: runInBackground trả về ngay, task tiếp tục chạy nền.
  // Vì runSafely đã tự bắt lỗi nên Promise này không bao giờ bị reject.
  runSafely();
}
