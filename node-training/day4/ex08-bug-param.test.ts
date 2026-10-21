import { expect, test } from 'vitest';
import { buildApp } from './ex08-bug-param.js';

test('đọc ví có sẵn', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/wallets/w1' });
  expect(res.statusCode).toBe(200);
  expect(res.json().owner).toBe('An');
});

test('ví lạ -> 404', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/wallets/w2' });
  expect(res.statusCode).toBe(404);
});
