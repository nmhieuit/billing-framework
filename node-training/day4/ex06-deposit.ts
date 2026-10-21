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

export function buildApp(wallets: Map<string, Wallet> = new Map()) {
  const app = Fastify();
  // TODO
  void wallets;
  return app;
}
