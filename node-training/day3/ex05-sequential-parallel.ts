// Bài 5 (Trung bình): lần lượt và song song.
// Mỗi "task" là một hàm trả về Promise<number>.
// runSequential(tasks): chạy từng task, task sau chỉ bắt đầu khi task trước xong. Trả về mảng kết quả theo thứ tự.
// runParallel(tasks):   khởi động tất cả cùng lúc, trả về mảng kết quả theo đúng thứ tự tasks. Gợi ý: Promise.all.
export type Task = () => Promise<number>;

export async function runSequential(tasks: Task[]): Promise<number[]> {
  // TODO: for...of + await
  return [];
}

export async function runParallel(tasks: Task[]): Promise<number[]> {
  // TODO: Promise.all(tasks.map(...))
  return [];
}
