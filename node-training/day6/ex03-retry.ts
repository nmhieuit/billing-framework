// Bài 3 (Trung bình): thử lại theo bậc (backoff).
// withRetry(task, delaysMs, sleep):
//   - gọi task(); nếu thành công trả kết quả luôn
//   - nếu task ném lỗi: chờ delaysMs[0] mili-giây (bằng hàm sleep được truyền vào) rồi thử lại, lần sau chờ delaysMs[1], ...
//   - hết các bậc chờ mà vẫn lỗi: ném lại lỗi cuối cùng
//   Tổng số lần gọi tối đa = delaysMs.length + 1.
// `sleep` được truyền vào để test chạy tức thì (không chờ thật).

// Hàm chờ thật, dùng làm giá trị mặc định cho tham số sleep
function realSleep(ms: number): Promise<void> {
  // Hàm này được Promise gọi ngay; resolve là hàm "báo đã xong" của Promise
  function startTimer(resolve: () => void): void {
    // Sau ms mili-giây thì gọi resolve, Promise hoàn thành và await bên ngoài chạy tiếp
    setTimeout(resolve, ms);
  }

  const waitPromise = new Promise<void>(startTimer);
  return waitPromise;
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
      // Chạy task. Thành công thì trả về luôn, kết thúc vòng lặp.
      const taskResult = await task();
      return taskResult;
    } catch (error) {
      // Task ném lỗi. Lấy thời gian chờ của lần thử lại này; hết bậc thì được undefined.
      // Debug: log attempt và delay ở đây để xem đang ở bậc nào.
      const delay = delaysMs[attempt];

      // Nhánh hết bậc chờ: không còn lượt thử lại nên ném lại lỗi cuối cùng
      if (delay === undefined) {
        throw error;
      }

      // Nhánh còn bậc chờ: chờ rồi sang vòng lặp tiếp theo để thử lại
      await sleep(delay);
      attempt = attempt + 1;
    }
  }
}
