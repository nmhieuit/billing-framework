// Bài 5 (Trung bình): lần lượt và song song.
// Mỗi "task" là một hàm trả về Promise<number>.
// runSequential(tasks): chạy từng task, task sau chỉ bắt đầu khi task trước xong. Trả về mảng kết quả theo thứ tự.
// runParallel(tasks):   khởi động tất cả cùng lúc, trả về mảng kết quả theo đúng thứ tự tasks. Gợi ý: Promise.all.

// Task: một hàm không có tham số, trả về Promise chứa một số
export type Task = () => Promise<number>;

// Chạy lần lượt: tổng thời gian = cộng thời gian từng task
export async function runSequential(tasks: Task[]): Promise<number[]> {
  const results: number[] = [];
  for (const task of tasks) {
    // await ngay trong vòng lặp: chờ task này xong mới sang task tiếp theo
    const value = await task();
    results.push(value);
  }
  return results;
}

// Chạy song song: tổng thời gian = thời gian của task lâu nhất
export async function runParallel(tasks: Task[]): Promise<number[]> {
  // Gọi từng task() ngay (chưa await) -> tất cả bắt đầu chạy cùng lúc, ta có mảng Promise
  const promises = tasks.map(function (task) {
    return task();
  });
  // Promise.all chờ tất cả xong, trả về mảng kết quả đúng thứ tự ban đầu
  return Promise.all(promises);
}
