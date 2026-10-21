// Bài 9 (Sửa lỗi): payment chậm làm cả chương trình bị "treo" theo.
// ping(url, timeoutMs) phải trả 'ok' nếu payment trả lời kịp, ngược lại 'timeout'.
// Test dùng payment giả chậm 1.5 giây nhưng chỉ cho phép chờ 200ms. Chạy `pnpm test day6/ex09`,
// xem thời gian và kết quả nhận được, rồi sửa: thiếu một tham số của fetch (xem ví dụ b-timeout.ts).
export async function ping(url: string, timeoutMs: number): Promise<'ok' | 'timeout'> {
  try {
    await fetch(`${url}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1 }),
    });
    void timeoutMs;
    return 'ok';
  } catch {
    return 'timeout';
  }
}
