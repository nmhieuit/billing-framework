export interface DrainOptions {
  batchSize: number;
  /** Kiểm tra TRƯỚC mỗi lô; `false` thì dừng (hết ngân sách thời gian hoặc đang tắt). */
  shouldContinue?: () => boolean;
}

/**
 * Gọi `step(batchSize)` lặp lại để dọn dữ liệu theo lô: dừng khi một lô trả về ít hơn `batchSize`
 * (không còn gì đủ điều kiện) hoặc khi `shouldContinue()` trả `false`. Trả tổng số dòng.
 */
export async function drainBatches(
  step: (batchSize: number) => Promise<number>,
  options: DrainOptions,
): Promise<number> {
  let total = 0;
  for (;;) {
    if (options.shouldContinue && !options.shouldContinue()) return total;
    const rows = await step(options.batchSize);
    total += rows;
    if (rows < options.batchSize) return total;
  }
}
