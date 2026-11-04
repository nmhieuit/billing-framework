// Bài 4 (Trung bình): lớp HTTP mỏng bên trên service (service đã viết sẵn ở support/).
//   GET  /wallets/:id          200 ví  |  404 { error: <message> } nếu WalletNotFoundError
//   POST /wallets/:id/deposit  body { amount }  200 ví mới
//        InvalidAmountError    -> 400 { error: <message> }
//        WalletNotFoundError   -> 404 { error: <message> }
// Quy tắc lớp mỏng: handler KHÔNG tự kiểm tra nghiệp vụ, chỉ gọi service và đổi lỗi thành mã HTTP.
import Fastify from 'fastify';
import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import type { WalletService } from './support/wallet-service.js';

// Service được truyền vào từ bên ngoài, route chỉ việc gọi
export function buildApp(service: WalletService) {
  const app = Fastify();

  // Đọc ví
  app.get('/wallets/:id', async function (request, reply) {
    const params = request.params as { id: string };
    try {
      // Nhờ service lấy ví; không có thì service ném WalletNotFoundError
      const wallet = service.get(params.id);
      return wallet;
    } catch (error) {
      // instanceof: kiểm tra lỗi có thuộc loại này không
      if (error instanceof WalletNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      // Lỗi không lường trước thì ném tiếp, Fastify sẽ trả 500
      throw error;
    }
  });

  // Nạp tiền
  app.post('/wallets/:id/deposit', async function (request, reply) {
    const params = request.params as { id: string };
    const body = request.body as { amount: number };
    try {
      const wallet = service.deposit(params.id, body.amount);
      return wallet;
    } catch (error) {
      // Mỗi loại lỗi nghiệp vụ ứng với một mã HTTP
      if (error instanceof InvalidAmountError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof WalletNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });

  return app;
}
