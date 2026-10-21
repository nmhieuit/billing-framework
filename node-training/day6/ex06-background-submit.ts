// Bài 6 (Nâng cao): trả lời 202 ngay, gửi sang payment ở chạy nền.
// buildApp({ submit, log }) trả về { app, drain }.
//   POST /topups body { amount }:
//       tạo topup { id: 't1', amount, status: 'REQUESTED' } (id tăng dần), lưu vào Map,
//       trả NGAY 202 { id, status: 'REQUESTED' } — KHÔNG chờ submit.
//       Chạy nền: await submit(topup). Nếu submit trả 'created' -> status PENDING.
//       Nếu submit trả 'unavailable' -> giữ nguyên REQUESTED.
//       Nếu submit ném lỗi -> gọi log(`submit failed: ${error.message}`), giữ nguyên REQUESTED, KHÔNG để lỗi rơi ra ngoài.
//   GET /topups/:id -> 200 topup hiện tại | 404 { error: 'topup not found' }
//   drain(): trả Promise hoàn thành khi MỌI công việc chạy nền đã xong (dùng cho test, và khi tắt server).
// Gợi ý: giữ một Set<Promise>; thêm khi bắt đầu, xóa trong .finally (xem ví dụ d-chay-nen.ts).
import Fastify from 'fastify';

export interface Topup {
  id: string;
  amount: number;
  status: 'REQUESTED' | 'PENDING';
}

export interface Deps {
  submit: (topup: Topup) => Promise<'created' | 'unavailable'>;
  log: (line: string) => void;
}

export function buildApp(deps: Deps) {
  const app = Fastify();
  // TODO
  void deps;
  return { app, drain: async () => {} };
}
