// Bài 4 (Trung bình): chỉ thử lại khi đáng thử lại.
// submitWithRetry(attempt, delaysMs, sleep) trong đó attempt() trả về ChargeOutcome (xem bài 2).
//   'created'      -> dừng, trả kết quả ngay
//   'rejected'     -> dừng, trả kết quả ngay (thử lại vô ích)
//   'unavailable'  -> chờ delaysMs[i] rồi gọi lại; hết bậc chờ thì trả { outcome: 'unavailable' }
// Trả về kết quả cuối cùng kèm số lần đã gọi: { ...outcome, attempts }.
export type ChargeOutcome =
  | { outcome: 'created'; chargeId: string }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable' };

export async function submitWithRetry(
  attempt: () => Promise<ChargeOutcome>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void>,
): Promise<ChargeOutcome & { attempts: number }> {
  // TODO
  void attempt;
  void delaysMs;
  void sleep;
  return { outcome: 'unavailable', attempts: 0 };
}
