/**
 * Phân vị kiểu nearest-rank: sắp tăng dần, lấy phần tử thứ rank (đếm từ 1) với
 *   rank = max(1, ceil(p * n / 100))
 * Ví dụ 1..100: p50 = 50, p95 = 95, p99 = 99, p100 = 100; p0 = phần tử nhỏ nhất.
 * Không nội suy: kết quả luôn là một giá trị có trong mẫu. Mảng rỗng → NaN.
 * p phải thuộc [0,100] (NaN hay ngoài khoảng đều ném lỗi). Không sửa mảng đầu vào.
 */
export function percentile(values: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 100)) {
    throw new RangeError(`percentile p must be within [0,100], got ${p}`);
  }
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  // Nhân trước rồi chia sau để tránh sai số dấu phẩy động của p / 100.
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1]!;
}

export interface LatencySummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Tóm tắt độ trễ (ms). Mảng rỗng: count 0, các số còn lại NaN. */
export function summarizeLatencies(latenciesMs: readonly number[]): LatencySummary {
  if (latenciesMs.length === 0) {
    return {
      count: 0,
      mean: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
    };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}
