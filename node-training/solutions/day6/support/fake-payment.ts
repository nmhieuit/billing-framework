// Payment GIẢ để thực hành (đã viết sẵn, không cần sửa).
// POST /charges body { amount } -> 202 { chargeId } khi ok
// Mỗi lần gọi lấy hành vi theo thứ tự trong `script` (hết thì lặp lại phần tử cuối):
//   'ok'     trả 202 ngay
//   'slow'   chờ `slowMs` rồi mới trả 202 (mô phỏng payment chậm)
//   'error'  trả 500
//   'reject' trả 422 (từ chối nghiệp vụ, thử lại cũng vô ích)
import Fastify from 'fastify';

export type Behavior = 'ok' | 'slow' | 'error' | 'reject';

export interface FakePayment {
  url: string;
  calls: () => number;
  close: () => Promise<void>;
}

export async function startFakePayment(script: Behavior[] = ['ok'], slowMs = 1000): Promise<FakePayment> {
  const app = Fastify();
  let calls = 0;

  app.post('/charges', async (_request, reply) => {
    const behavior = script[Math.min(calls, script.length - 1)] ?? 'ok';
    calls += 1;
    if (behavior === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, slowMs));
    }
    if (behavior === 'error') {
      return reply.code(500).send({ error: 'boom' });
    }
    if (behavior === 'reject') {
      return reply.code(422).send({ error: 'rejected' });
    }
    return reply.code(202).send({ chargeId: `ch_${calls}` });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, calls: () => calls, close: () => app.close() };
}
