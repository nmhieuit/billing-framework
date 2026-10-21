// Bài 10 (Săn lỗi bằng debugger, nâng cao): hàm dưới đây có 3 lỗi logic. Test đỏ ở nhiều chỗ.
// Cách làm: đặt breakpoint ở dòng đầu hàm, bấm "Debug" trên test (xem hướng dẫn Ngày 6),
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
  let latest: Charge | null = null;

  for (const charge of charges) {
    if (charge.status === 'succeeded') {
      succeededTotal = charge.amount;
    }
    if (charge.status === 'pending') {
      failedCount += 1;
    }
    if (latest === null || charge.createdAt < latest.createdAt) {
      latest = charge;
    }
  }

  return { succeededTotal, failedCount, latestId: latest ? latest.id : null };
}
