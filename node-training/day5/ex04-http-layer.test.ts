import { expect, test } from 'vitest';
import { buildApp } from './ex04-http-layer.js';
import { InMemoryWalletRepository } from './support/wallet-repository.js';
import { WalletService } from './support/wallet-service.js';

function setup() {
  const service = new WalletService(new InMemoryWalletRepository());
  service.open('An');
  return buildApp(service);
}

test('đọc ví', async () => {
  const res = await setup().inject({ method: 'GET', url: '/wallets/w-an' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ id: 'w-an', owner: 'An', balance: 0 });
});

test('ví lạ -> 404', async () => {
  const res = await setup().inject({ method: 'GET', url: '/wallets/zz' });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'wallet not found: zz' });
});

test('nạp tiền', async () => {
  const app = setup();
  const res = await app.inject({ method: 'POST', url: '/wallets/w-an/deposit', payload: { amount: 70 } });
  expect(res.statusCode).toBe(200);
  expect(res.json().balance).toBe(70);
});

test('nạp tiền sai -> 400', async () => {
  const res = await setup().inject({ method: 'POST', url: '/wallets/w-an/deposit', payload: { amount: -1 } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'amount must be a positive integer' });
});

test('nạp vào ví lạ -> 404', async () => {
  const res = await setup().inject({ method: 'POST', url: '/wallets/zz/deposit', payload: { amount: 5 } });
  expect(res.statusCode).toBe(404);
});
