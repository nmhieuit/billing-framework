// Bài 8 (Sửa lỗi): GET /wallets/w1 luôn trả 404 dù ví tồn tại.
// Mẹo debug: thêm console.log(request.params) vào handler để xem bên trong có gì.
// (Bản này đã sửa: lỗi gốc là lấy sai tên tham số so với ":id" trong đường dẫn.)
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  // Kho ví giả với một ví w1
  const wallets = new Map([['w1', { id: 'w1', owner: 'An', balance: 10 }]]);

  // Tên tham số trong đường dẫn là "id", nên phải đọc params.id (không phải tên khác)
  app.get('/wallets/:id', async function (request, reply) {
    const params = request.params as { id: string };
    const wallet = wallets.get(params.id);

    if (wallet === undefined) {
      return reply.code(404).send({ error: 'wallet not found' });
    }
    return wallet;
  });

  return app;
}
