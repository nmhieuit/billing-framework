// Bài 8 (Sửa lỗi): GET /wallets/w1 luôn trả 404 dù ví tồn tại.
// Chạy `pnpm test day4/ex08`. Mẹo: thêm console.log(request.params) vào handler để xem bên trong có gì.
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  const wallets = new Map([['w1', { id: 'w1', owner: 'An', balance: 10 }]]);

  app.get('/wallets/:walletId', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wallet = wallets.get(id);
    if (!wallet) {
      return reply.code(404).send({ error: 'wallet not found' });
    }
    return wallet;
  });

  return app;
}
