// Bài 5 (Nâng cao): máy trạng thái của một lệnh nạp tiền (topup) — hàm thuần, không đụng mạng.
// Trạng thái: REQUESTED (mới/đang chờ gọi lại), PENDING (payment đã nhận, chờ kết quả), FAILED.
// applyOutcome(topup, outcome, now, delaysSeconds) trả về topup MỚI (không sửa topup cũ):
//   outcome 'created' (có chargeId)  -> status PENDING, lưu chargeId, nextAttemptAt = null
//   outcome 'rejected'               -> status FAILED, failureCode 'PAYMENT_REJECTED', nextAttemptAt = null
//   outcome 'unavailable'            -> attempts + 1
//        nếu attempts MỚI <= delaysSeconds.length: vẫn REQUESTED, nextAttemptAt = now + delaysSeconds[attempts mới - 1] giây
//        ngược lại:                   FAILED, failureCode 'PAYMENT_UNAVAILABLE', nextAttemptAt = null
// Ví dụ delaysSeconds = [1, 5, 30]: lần unavailable thứ 1 -> chờ 1s, thứ 2 -> 5s, thứ 3 -> 30s, thứ 4 -> FAILED.

// Một lệnh nạp tiền
export interface Topup {
  id: string;
  amount: number;
  status: 'REQUESTED' | 'PENDING' | 'FAILED';
  attempts: number; // số lần gọi payment mà payment không sẵn sàng
  chargeId: string | null; // null = chưa có
  failureCode: string | null;
  nextAttemptAt: Date | null; // khi nào được thử gọi lại; null = không thử nữa
}

// Kết quả của một lần gọi payment (giống ChargeOutcome ở bài 2)
export type Outcome = { outcome: 'created'; chargeId: string } | { outcome: 'rejected'; status: number } | { outcome: 'unavailable' };

// Tạo topup mới: đang ở trạng thái REQUESTED, được phép gọi payment ngay (nextAttemptAt = now)
export function newTopup(id: string, amount: number, now: Date): Topup {
  return { id, amount, status: 'REQUESTED', attempts: 0, chargeId: null, failureCode: null, nextAttemptAt: now };
}

// Hàm thuần: nhận topup cũ và kết quả, trả về topup MỚI, không sửa topup cũ
export function applyOutcome(topup: Topup, outcome: Outcome, now: Date, delaysSeconds: number[]): Topup {
  // payment đã nhận yêu cầu -> chuyển sang PENDING
  if (outcome.outcome === 'created') {
    // { ...topup, ... }: sao chép topup rồi ghi đè các trường liệt kê sau đó
    return { ...topup, status: 'PENDING', chargeId: outcome.chargeId, nextAttemptAt: null };
  }

  // payment từ chối -> thất bại hẳn, không thử lại
  if (outcome.outcome === 'rejected') {
    return { ...topup, status: 'FAILED', failureCode: 'PAYMENT_REJECTED', nextAttemptAt: null };
  }

  // Còn lại là 'unavailable': tăng số lần thất bại
  const newAttempts = topup.attempts + 1;

  // Còn bậc chờ -> hẹn thử lại sau delaysSeconds[newAttempts - 1] giây
  if (newAttempts <= delaysSeconds.length) {
    const waitSeconds = delaysSeconds[newAttempts - 1];
    // getTime() là số mili-giây; cộng thêm giây x 1000 để ra thời điểm thử lại
    const nextAttemptAt = new Date(now.getTime() + waitSeconds * 1000);
    return { ...topup, attempts: newAttempts, nextAttemptAt };
  }

  // Hết bậc chờ -> bỏ cuộc (attempts giữ nguyên số lần tối đa)
  return { ...topup, status: 'FAILED', failureCode: 'PAYMENT_UNAVAILABLE', nextAttemptAt: null };
}
