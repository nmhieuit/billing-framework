// Bài 3 (Trung bình): thử lại theo bậc (backoff).
// withRetry(task, delaysMs, sleep):
//   - gọi task(); nếu thành công trả kết quả luôn
//   - nếu task ném lỗi: chờ delaysMs[0] mili-giây (bằng hàm sleep được truyền vào) rồi thử lại, lần sau chờ delaysMs[1], ...
//   - hết các bậc chờ mà vẫn lỗi: ném lại lỗi cuối cùng
//   Tổng số lần gọi tối đa = delaysMs.length + 1.
// `sleep` được truyền vào để test chạy tức thì (không chờ thật).

// Hàm chờ thật, dùng làm giá trị mặc định cho tham số sleep
function realSleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// <T> là kiểu của kết quả task: task trả về Promise<T> thì withRetry cũng trả về Promise<T>
export async function withRetry<T>(
  task: () => Promise<T>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  // attempt = số lần đã thất bại, cũng là chỉ số của bậc chờ kế tiếp
  let attempt = 0;

  // Lặp mãi cho đến khi return (thành công) hoặc throw (hết lượt)
  while (true) {
    try {
      // Thành công thì trả về luôn, kết thúc vòng lặp
      return await task();
    } catch (error) {
      // Lấy thời gian chờ của lần thử lại này; hết bậc thì được undefined
      const delay = delaysMs[attempt];

      if (delay === undefined) {
        // Hết bậc chờ: ném lại lỗi cuối cùng
        throw error;
      }

      await sleep(delay);
      attempt = attempt + 1;
    }
  }
}
