import { expect, test } from 'vitest';
import { buildApp } from './ex04-get-wallet.js';

test('đọc ví đã tạo', async () => {
  const app = buildApp();
  await app.inject({ method: 'POST', url: '/wallets', payload: { owner: 'An' } });
  const res = await app.inject({ method: 'GET', url: '/wallets/w1' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ id: 'w1', owner: 'An', balance: 0 });
});

test('ví không tồn tại -> 404', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/wallets/w99' });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'wallet not found' });
});
