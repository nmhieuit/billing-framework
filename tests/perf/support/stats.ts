/** Trung vị: số phần tử lẻ lấy phần tử giữa, chẵn lấy trung bình hai phần tử giữa. Rỗng → NaN. Không sửa đầu vào. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Giá trị nhỏ nhất và lớn nhất. Rỗng → NaN cho cả hai. */
export function range(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) return { min: Number.NaN, max: Number.NaN };
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
