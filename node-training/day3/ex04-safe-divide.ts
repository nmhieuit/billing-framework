// Bài 4 (Trung bình): async/await + try/catch.
// divideAsync đã viết sẵn: trả Promise<number>, nhưng reject (báo lỗi) khi b = 0.
// Bạn viết safeDivide(a, b): KHÔNG bao giờ ném lỗi, luôn trả về một trong hai dạng:
//   { ok: true, value: 5 }                         khi chia được
//   { ok: false, error: 'division by zero' }       khi divideAsync bị lỗi (lấy error.message)
export async function divideAsync(a: number, b: number): Promise<number> {
  if (b === 0) {
    throw new Error('division by zero');
  }
  return a / b;
}

export type DivideResult = { ok: true; value: number } | { ok: false; error: string };

export async function safeDivide(a: number, b: number): Promise<DivideResult> {
  // TODO: try { const value = await divideAsync(a, b); ... } catch (error) { ... }
  return { ok: false, error: 'TODO' };
}
