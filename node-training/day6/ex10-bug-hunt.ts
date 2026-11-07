// Bài 10 (Săn lỗi bằng debugger, nâng cao): hàm dưới đây từng có 3 lỗi logic (bản này đã sửa).
// Cách làm khi gặp lỗi: đặt breakpoint ở dòng đầu hàm, bấm "Debug" trên test,
// bước từng dòng (F10), xem giá trị biến ở khung VARIABLES và tìm dòng làm giá trị sai.
// summarize(charges) trả về { succeededTotal, failedCount, latestId }
//   succeededTotal = tổng amount của các charge có status 'succeeded'
//   failedCount    = số charge có status 'failed'
//   latestId       = id của charge có createdAt lớn nhất (mới nhất); mảng rỗng -> null

export interface Charge {
  id: string;
  amount: number;
  status: 'succeeded' | 'failed' | 'pending';
  createdAt: number;
}

export function summarize(charges: Charge[]) {
  let succeededTotal = 0;
  let failedCount = 0;
  // Charge mới nhất tìm được cho đến lúc này (null = chưa có)
  let latest: Charge | null = null;

  for (const charge of charges) {
    // Nhánh charge thành công: cộng tiền vào tổng
    if (charge.status === 'succeeded') {
      // Lỗi 1 (đã sửa): phải CỘNG DỒN (+=), không phải gán (=) đè lên giá trị cũ
      succeededTotal = succeededTotal + charge.amount;
    }

    // Nhánh charge thất bại: tăng bộ đếm
    if (charge.status === 'failed') {
      // Lỗi 2 (đã sửa): đếm status 'failed', không phải 'pending'
      failedCount = failedCount + 1;
    }

    // Charge đầu tiên gặp, hoặc charge có createdAt lớn hơn charge mới nhất hiện tại -> cập nhật latest
    // Lỗi 3 (đã sửa): mới nhất = createdAt LỚN nhất, nên dùng dấu > (không phải <)
    if (latest === null || charge.createdAt > latest.createdAt) {
      latest = charge;
    }
  }

  // Có charge mới nhất thì lấy id, không thì null (mảng rỗng)
  let latestId: string | null = null;
  if (latest !== null) {
    latestId = latest.id;
  }

  const summary = { succeededTotal, failedCount, latestId };
  return summary;
}
