// Bài 8 (Sửa lỗi): hàm retry thử sai số lần.
// retryTimes(task, retries): gọi task; nếu lỗi thì thử lại tối đa `retries` lần (tổng tối đa retries + 1 lần gọi).
// Lỗi gốc thường là so sánh sai điều kiện vòng lặp (dùng < thay cho <=) nên thiếu mất một lần gọi.

// task    : hàm async cần chạy (ví dụ: gọi cổng thanh toán). Có thể thành công hoặc ném lỗi.
// retries : số lần được phép THỬ LẠI sau lần gọi đầu tiên.
// Trả về  : kết quả của task nếu có một lần chạy thành công.
export async function retryTimes<T>(task: () => Promise<T>, retries: number): Promise<T> {
  // Lưu lỗi của lần thất bại gần nhất, để ném ra nếu hết lượt mà vẫn lỗi
  let lastError: unknown;

  // Mỗi vòng = một lần gọi task. attempt chạy từ 0 đến retries (gồm cả retries)
  // nên tổng số lần gọi = retries + 1 (1 lần đầu + retries lần thử lại)
  for (let attempt = 0; attempt <= retries; attempt = attempt + 1) {
    try {
      // Chạy task. Thành công thì trả về ngay, không thử nữa.
      // Debug: log attempt ở đây để xem đang ở lần gọi thứ mấy.
      const taskResult = await task();
      return taskResult;
    } catch (error) {
      // Thất bại: ghi nhớ lỗi rồi sang vòng kế tiếp để thử lại
      lastError = error;
    }
  }

  // Ra khỏi vòng lặp nghĩa là mọi lần gọi đều lỗi -> ném lại lỗi cuối cùng
  throw lastError;
}
