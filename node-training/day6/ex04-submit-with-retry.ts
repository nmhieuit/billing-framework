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
  // Số lần đã gọi attempt()
  let attempts = 0;

  // Có delaysMs.length bậc chờ nên tối đa delaysMs.length + 1 lần gọi (i từ 0 đến delaysMs.length)
  for (let i = 0; i <= delaysMs.length; i = i + 1) {
    attempts = attempts + 1;
    const result = await attempt();

    // created hoặc rejected: có kết quả cuối cùng rồi, không thử lại nữa
    if (result.outcome === 'created' || result.outcome === 'rejected') {
      // { ...result, attempts }: sao chép các trường của result rồi thêm trường attempts
      return { ...result, attempts };
    }

    // unavailable: nếu còn bậc chờ thì chờ rồi vòng sau gọi lại
    if (i < delaysMs.length) {
      await sleep(delaysMs[i]);
    }
  }

  // Hết bậc chờ mà vẫn unavailable thì bỏ cuộc
  return { outcome: 'unavailable', attempts };
}
