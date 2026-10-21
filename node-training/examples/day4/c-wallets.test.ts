import { expect, test } from 'vitest';
import { buildApp } from './b-wallets.js';

test('tạo ví rồi đọc lại', async () => {
  const app = buildApp();

  const created = await app.inject({ method: 'POST', url: '/wallets', payload: { owner: 'An' } });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({ id: 'w1', owner: 'An', balance: 0 });

  const found = await app.inject({ method: 'GET', url: '/wallets/w1' });
  expect(found.statusCode).toBe(200);
  expect(found.json().owner).toBe('An');
});

test('ví không tồn tại -> 404', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/wallets/zzz' });
  expect(res.statusCode).toBe(404);
});

test('thiếu owner -> 400', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/wallets', payload: {} });
  expect(res.statusCode).toBe(400);
});
