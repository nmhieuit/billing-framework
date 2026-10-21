import { expect, test } from 'vitest';
import { buildApp } from './ex05-header.js';

test('có header', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/me', headers: { 'x-customer-id': 'c1' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ customerId: 'c1' });
});

test('thiếu header -> 401', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/me' });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'x-customer-id header is required' });
});
