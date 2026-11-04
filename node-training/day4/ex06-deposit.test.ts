import { expect, test } from 'vitest';
import { buildApp, type Wallet } from './ex06-deposit.js';

// Tạo kho ví có sẵn một ví w1 với số dư 100
function seed() {
  return new Map<string, Wallet>([['w1', { id: 'w1', owner: 'An', balance: 100 }]]);
}

test('nạp tiền cộng dồn', async () => {
  const app = buildApp(seed());
  const first = await app.inject({ method: 'POST', url: '/wallets/w1/deposit', payload: { amount: 50 } });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ id: 'w1', balance: 150 });

  // Nạp lần 2 cộng tiếp vào số dư hiện tại
  const second = await app.inject({ method: 'POST', url: '/wallets/w1/deposit', payload: { amount: 1 } });
  expect(second.json().balance).toBe(151);
});

test('ví không tồn tại', async () => {
  const res = await buildApp(seed()).inject({ method: 'POST', url: '/wallets/zz/deposit', payload: { amount: 5 } });
  expect(res.statusCode).toBe(404);
});

// Thử nhiều giá trị amount sai: thiếu, 0, âm, số lẻ, chuỗi
test.each([[{}], [{ amount: 0 }], [{ amount: -5 }], [{ amount: 1.5 }], [{ amount: '10' }]])(
  'amount không hợp lệ %j -> 400 và số dư không đổi',
  async (payload) => {
    const wallets = seed();
    const res = await buildApp(wallets).inject({ method: 'POST', url: '/wallets/w1/deposit', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'amount must be a positive integer' });
    // Số dư vẫn là 100
    expect(wallets.get('w1')?.balance).toBe(100);
  },
);
