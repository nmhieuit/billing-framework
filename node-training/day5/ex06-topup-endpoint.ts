// Bài 6 (Nâng cao): endpoint nạp tiền có Idempotency-Key (tự viết trọn vẹn, xem ví dụ d-app.ts).
// POST /topups  header `idempotency-key`, body { "amount": <số nguyên dương> }
//   thiếu header                         -> 400 { error: 'idempotency-key header is required' }
//   amount không hợp lệ                  -> 400 { error: 'amount must be a positive integer' }
//   lần đầu                              -> 201 { topupId: 't1', amount, balance }   (topupId tăng dần t1, t2, ...)
//   lặp lại cùng key + cùng body         -> trả lại Y NGUYÊN status và body lần đầu, kèm header `idempotent-replayed: true`;
//                                          KHÔNG cộng tiền thêm, KHÔNG tạo topupId mới
//   cùng key nhưng body khác             -> 422 { error: 'IDEMPOTENCY_KEY_REUSED' }
// `balance` là tổng tiền đã nạp của cả ứng dụng (một ví duy nhất, bắt đầu từ 0).
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  // TODO
  return app;
}
