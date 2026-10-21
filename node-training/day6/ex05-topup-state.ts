// Bài 5 (Nâng cao): máy trạng thái của một lệnh nạp tiền (topup) — hàm thuần, không đụng mạng.
// Trạng thái: REQUESTED (mới/đang chờ gọi lại), PENDING (payment đã nhận, chờ kết quả), FAILED.
// applyOutcome(topup, outcome, now, delaysSeconds) trả về topup MỚI (không sửa topup cũ):
//   outcome 'created' (có chargeId)  -> status PENDING, lưu chargeId, nextAttemptAt = null
//   outcome 'rejected'               -> status FAILED, failureCode 'PAYMENT_REJECTED', nextAttemptAt = null
//   outcome 'unavailable'            -> attempts + 1
//        nếu attempts MỚI <= delaysSeconds.length: vẫn REQUESTED, nextAttemptAt = now + delaysSeconds[attempts mới - 1] giây
//        ngược lại:                   FAILED, failureCode 'PAYMENT_UNAVAILABLE', nextAttemptAt = null
// Ví dụ delaysSeconds = [1, 5, 30]: lần unavailable thứ 1 -> chờ 1s, thứ 2 -> 5s, thứ 3 -> 30s, thứ 4 -> FAILED.
export interface Topup {
  id: string;
  amount: number;
  status: 'REQUESTED' | 'PENDING' | 'FAILED';
  attempts: number;
  chargeId: string | null;
  failureCode: string | null;
  nextAttemptAt: Date | null;
}

export type Outcome = { outcome: 'created'; chargeId: string } | { outcome: 'rejected'; status: number } | { outcome: 'unavailable' };

export function newTopup(id: string, amount: number, now: Date): Topup {
  return { id, amount, status: 'REQUESTED', attempts: 0, chargeId: null, failureCode: null, nextAttemptAt: now };
}

export function applyOutcome(topup: Topup, outcome: Outcome, now: Date, delaysSeconds: number[]): Topup {
  // TODO
  void outcome;
  void now;
  void delaysSeconds;
  return topup;
}
