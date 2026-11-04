// Bài 4 (Trung bình): async/await + try/catch.
// divideAsync đã viết sẵn: trả Promise<number>, nhưng reject (báo lỗi) khi b = 0.
// Bạn viết safeDivide(a, b): KHÔNG bao giờ ném lỗi, luôn trả về một trong hai dạng:
//   { ok: true, value: 5 }                         khi chia được
//   { ok: false, error: 'division by zero' }       khi divideAsync bị lỗi (lấy error.message)

// Hàm async luôn trả về Promise. Ném lỗi trong hàm async = Promise bị reject
export async function divideAsync(a: number, b: number): Promise<number> {
  if (b === 0) {
    throw new Error('division by zero');
  }
  return a / b;
}

// Kết quả là MỘT TRONG HAI dạng (dấu | nghĩa là "hoặc"):
//   thành công (ok = true, có value) hoặc thất bại (ok = false, có error)
export type DivideResult = { ok: true; value: number } | { ok: false; error: string };

export async function safeDivide(a: number, b: number): Promise<DivideResult> {
  try {
    // await chờ Promise xong; nếu Promise bị reject thì nhảy xuống catch
    const value = await divideAsync(a, b);
    return { ok: true, value };
  } catch (error) {
    // "as Error": báo cho TypeScript biết error là đối tượng Error để đọc .message
    const message = (error as Error).message;
    return { ok: false, error: message };
  }
}
