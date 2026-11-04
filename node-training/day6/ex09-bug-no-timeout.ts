// Bài 9 (Sửa lỗi): payment chậm làm cả chương trình bị "treo" theo.
// ping(url, timeoutMs) phải trả 'ok' nếu payment trả lời kịp, ngược lại 'timeout'.
// Lỗi gốc: gọi fetch mà thiếu tham số signal nên fetch chờ vô thời hạn.
// Bản sửa: thêm signal: AbortSignal.timeout(timeoutMs).

export async function ping(url: string, timeoutMs: number): Promise<'ok' | 'timeout'> {
  try {
    await fetch(`${url}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1 }),
      // Quá timeoutMs mili-giây thì request bị hủy và fetch ném lỗi (nhảy xuống catch)
      signal: AbortSignal.timeout(timeoutMs),
    });
    return 'ok';
  } catch {
    return 'timeout';
  }
}
