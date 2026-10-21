// Bài 2 (Trung bình): cổng gọi payment có TIMEOUT, trả về kết quả có tên rõ ràng thay vì ném lỗi.
// createCharge(url, amount, timeoutMs) trả về MỘT trong ba dạng:
//   { outcome: 'created', chargeId }     khi payment trả 202
//   { outcome: 'rejected', status }      khi payment trả 4xx (từ chối, thử lại vô ích)
//   { outcome: 'unavailable' }           khi quá thời gian chờ, lỗi mạng, hoặc payment trả 5xx (có thể thử lại)
// Hàm này KHÔNG bao giờ ném lỗi. Gợi ý: signal: AbortSignal.timeout(timeoutMs) và try/catch quanh fetch.
export type ChargeOutcome =
  | { outcome: 'created'; chargeId: string }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable' };

export async function createCharge(url: string, amount: number, timeoutMs: number): Promise<ChargeOutcome> {
  // TODO
  void url;
  void amount;
  void timeoutMs;
  return { outcome: 'unavailable' };
}
