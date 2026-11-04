// Bài 6 (Nâng cao): POST /wallets/:id/deposit với body { "amount": 100 }.
//   Ví không tồn tại:                  404 { error: 'wallet not found' }
//   amount không phải số nguyên dương: 400 { error: 'amount must be a positive integer' }
//   Thành công:                        200 { id, balance: <số dư mới> }
// Thứ tự kiểm tra: tìm ví (404) trước, rồi mới kiểm tra amount (400).
// buildApp nhận sẵn Map các ví để test nạp dữ liệu có sẵn.
import Fastify from 'fastify';

export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

// "= new Map()": nếu không truyền gì thì dùng một Map rỗng
export function buildApp(wallets: Map<string, Wallet> = new Map()) {
  const app = Fastify();

  app.post('/wallets/:id/deposit', async function (request, reply) {
    // Lấy id từ đường dẫn và amount từ body (khai báo kiểu để TypeScript hiểu)
    const params = request.params as { id: string };
    const body = request.body as { amount?: unknown } | null;

    // Bước 1: tìm ví, không có thì 404
    const wallet = wallets.get(params.id);
    if (wallet === undefined) {
      return reply.code(404).send({ error: 'wallet not found' });
    }

    // Bước 2: kiểm tra amount phải là số nguyên dương, sai thì 400
    const amount = body === null ? undefined : body.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive integer' });
    }

    // Bước 3: hợp lệ thì cộng tiền và trả về số dư mới
    wallet.balance = wallet.balance + amount;
    return { id: wallet.id, balance: wallet.balance };
  });

  return app;
}
