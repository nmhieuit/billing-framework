// Bài 3 (Trung bình): POST /wallets với body JSON { "owner": "An" }.
//   Thành công: mã 201, trả về { id: 'w1', owner: 'An', balance: 0 }   (id tăng dần: w1, w2, ...)
//   owner thiếu / không phải chuỗi / chuỗi rỗng: mã 400, { error: 'owner is required' }
// Xem ví dụ b-wallets.ts trong bài học (nhưng hãy tự gõ, đừng chép).
import Fastify from 'fastify';

export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export function buildApp() {
  const app = Fastify();
  const wallets = new Map<string, Wallet>();
  // TODO: app.post('/wallets', async (request, reply) => { ... });
  void wallets;
  return app;
}
