// Bài 3 (Trung bình): thử lại theo bậc (backoff).
// withRetry(task, delaysMs, sleep):
//   - gọi task(); nếu thành công trả kết quả luôn
//   - nếu task ném lỗi: chờ delaysMs[0] mili-giây (bằng hàm sleep được truyền vào) rồi thử lại, lần sau chờ delaysMs[1], ...
//   - hết các bậc chờ mà vẫn lỗi: ném lại lỗi cuối cùng
//   Tổng số lần gọi tối đa = delaysMs.length + 1.
// `sleep` được truyền vào để test chạy tức thì (không chờ thật). Xem ví dụ c-retry.ts.
export async function withRetry<T>(
  task: () => Promise<T>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  // TODO
  void task;
  void delaysMs;
  void sleep;
  throw new Error('TODO');
}
