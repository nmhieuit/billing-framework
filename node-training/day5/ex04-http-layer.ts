// Bài 4 (Trung bình): lớp HTTP mỏng bên trên service (service đã viết sẵn ở support/).
//   GET  /wallets/:id          200 ví  |  404 { error: <message> } nếu WalletNotFoundError
//   POST /wallets/:id/deposit  body { amount }  200 ví mới
//        InvalidAmountError    -> 400 { error: <message> }
//        WalletNotFoundError   -> 404 { error: <message> }
// Quy tắc lớp mỏng: handler KHÔNG tự kiểm tra nghiệp vụ, chỉ gọi service và đổi lỗi thành mã HTTP.
// Gợi ý: dùng try/catch và `error instanceof WalletNotFoundError`; lỗi lạ thì ném tiếp (throw error).
import Fastify from 'fastify';
import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import type { WalletService } from './support/wallet-service.js';

export function buildApp(service: WalletService) {
  const app = Fastify();
  // TODO
  void service;
  void InvalidAmountError;
  void WalletNotFoundError;
  return app;
}
