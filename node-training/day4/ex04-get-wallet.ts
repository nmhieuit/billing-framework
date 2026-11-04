// Bài 4 (Trung bình): GET /wallets/:id.
//   Có ví: 200 và đối tượng ví.   Không có: 404 { error: 'wallet not found' }
// POST /wallets đã được viết sẵn. Bạn chỉ thêm GET.
import Fastify from 'fastify';

export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export function buildApp() {
  const app = Fastify();
  const wallets = new Map<string, Wallet>();

  // Tạo ví (giống bài 3)
  app.post('/wallets', async function (request, reply) {
    const body = request.body as { owner?: unknown } | null;
    if (body === null || typeof body.owner !== 'string' || body.owner === '') {
      return reply.code(400).send({ error: 'owner is required' });
    }
    const newId = 'w' + (wallets.size + 1);
    const wallet: Wallet = { id: newId, owner: body.owner, balance: 0 };
    wallets.set(wallet.id, wallet);
    return reply.code(201).send(wallet);
  });

  // Đọc ví theo id trên đường dẫn
  app.get('/wallets/:id', async function (request, reply) {
    const params = request.params as { id: string };

    // Map.get trả về ví, hoặc undefined nếu không có khóa này
    const wallet = wallets.get(params.id);

    if (wallet === undefined) {
      // 404 = Not Found (không tìm thấy)
      return reply.code(404).send({ error: 'wallet not found' });
    }

    // Trả về ví (mặc định mã 200)
    return wallet;
  });

  return app;
}
