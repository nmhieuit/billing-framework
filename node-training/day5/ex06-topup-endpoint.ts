// Bài 6 (Nâng cao): endpoint nạp tiền có Idempotency-Key.
// POST /topups  header `idempotency-key`, body { "amount": <số nguyên dương> }
//   thiếu header                         -> 400 { error: 'idempotency-key header is required' }
//   amount không hợp lệ                  -> 400 { error: 'amount must be a positive integer' }
//   lần đầu                              -> 201 { topupId: 't1', amount, balance }   (topupId tăng dần t1, t2, ...)
//   lặp lại cùng key + cùng body         -> trả lại Y NGUYÊN status và body lần đầu, kèm header `idempotent-replayed: true`;
//                                          KHÔNG cộng tiền thêm, KHÔNG tạo topupId mới
//   cùng key nhưng body khác             -> 422 { error: 'IDEMPOTENCY_KEY_REUSED' }
// `balance` là tổng tiền đã nạp của cả ứng dụng (một ví duy nhất, bắt đầu từ 0).
import Fastify from 'fastify';
import { createIdempotencyStore } from './ex05-idempotency-store.js';

export function buildApp() {
  const app = Fastify();

  // Trạng thái của ứng dụng (nằm trong bộ nhớ)
  let balance = 0; // tổng tiền đã nạp
  let nextTopupId = 1; // số thứ tự cho topupId kế tiếp

  // Bộ nhớ chống trùng đã viết ở bài 5
  const store = createIdempotencyStore();

  app.post('/topups', async function (request, reply) {
    // Bước 1: đọc header idempotency-key, bắt buộc phải có và là chuỗi
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key === '') {
      return reply.code(400).send({ error: 'idempotency-key header is required' });
    }

    // Bước 2: kiểm tra amount trong body
    const body = request.body as { amount?: unknown } | null;
    const amount = body === null ? undefined : body.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive integer' });
    }

    // Bước 3: dùng store để chỉ xử lý nạp tiền ĐÚNG MỘT LẦN cho mỗi key
    try {
      // fingerprint: chuỗi đại diện cho nội dung yêu cầu, dùng để phát hiện cùng key mà body khác
      const fingerprint = JSON.stringify(body);

      const outcome = store.run(key, fingerprint, function () {
        // Phần này chỉ chạy ở lần đầu của mỗi key
        balance = balance + amount;
        const topupId = 't' + nextTopupId;
        nextTopupId = nextTopupId + 1;
        return { topupId, amount, balance };
      });

      // Nếu là kết quả cũ được trả lại thì báo cho client biết bằng header
      if (outcome.replayed) {
        reply.header('idempotent-replayed', 'true');
      }

      return reply.code(201).send(outcome.result);
    } catch (error) {
      // Cùng key nhưng body khác -> 422 (Unprocessable: yêu cầu không hợp lệ về ngữ nghĩa)
      if (error instanceof Error && error.message === 'IDEMPOTENCY_KEY_REUSED') {
        return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
      }
      throw error;
    }
  });

  return app;
}
