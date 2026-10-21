import { expect, test } from 'vitest';
import { buildApp } from './ex03-create-wallet.js';

test('tạo ví thành công', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/wallets', payload: { owner: 'An' } });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toEqual({ id: 'w1', owner: 'An', balance: 0 });
});

test('id tăng dần', async () => {
  const app = buildApp();
  await app.inject({ method: 'POST', url: '/wallets', payload: { owner: 'An' } });
  const second = await app.inject({ method: 'POST', url: '/wallets', payload: { owner: 'Bình' } });
  expect(second.json().id).toBe('w2');
});

test.each([[{}], [{ owner: '' }], [{ owner: 123 }]])('body %j -> 400', async (payload) => {
  const res = await buildApp().inject({ method: 'POST', url: '/wallets', payload });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'owner is required' });
});
