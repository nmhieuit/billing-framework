// Bài 8 (Sửa lỗi): hàm retry thử sai số lần.
// retryTimes(task, retries): gọi task; nếu lỗi thì thử lại tối đa `retries` lần (tổng tối đa retries + 1 lần gọi).
// Chạy `pnpm test day6/ex08`, so "expected" với "received" trong thông báo lỗi, rồi sửa 1 chỗ.
export async function retryTimes<T>(task: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
