import { expect, test } from 'vitest';
import { buildApp } from './ex06-topup-endpoint.js';

type App = ReturnType<typeof buildApp>;
const send = (app: App, key: string | undefined, payload: unknown) =>
  app.inject({ method: 'POST', url: '/topups', headers: key ? { 'idempotency-key': key } : {}, payload: payload as object });

test('lần đầu: 201', async () => {
  const res = await send(buildApp(), 'k1', { amount: 100 });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toEqual({ topupId: 't1', amount: 100, balance: 100 });
});

test('hai key khác nhau: cộng dồn, id tăng', async () => {
  const app = buildApp();
  await send(app, 'k1', { amount: 100 });
  const second = await send(app, 'k2', { amount: 50 });
  expect(second.json()).toEqual({ topupId: 't2', amount: 50, balance: 150 });
});

test('gửi lại: trả y nguyên, không cộng thêm', async () => {
  const app = buildApp();
  const first = await send(app, 'k1', { amount: 100 });
  const again = await send(app, 'k1', { amount: 100 });
  expect(again.statusCode).toBe(first.statusCode);
  expect(again.json()).toEqual(first.json());
  expect(again.headers['idempotent-replayed']).toBe('true');
  expect(first.headers['idempotent-replayed']).toBeUndefined();
  const next = await send(app, 'k2', { amount: 1 });
  expect(next.json().balance).toBe(101);
});

test('cùng key khác nội dung: 422', async () => {
  const app = buildApp();
  await send(app, 'k1', { amount: 100 });
  const res = await send(app, 'k1', { amount: 999 });
  expect(res.statusCode).toBe(422);
  expect(res.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
});

test('thiếu header', async () => {
  const res = await send(buildApp(), undefined, { amount: 100 });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'idempotency-key header is required' });
});

test.each([[{}], [{ amount: 0 }], [{ amount: 2.5 }], [{ amount: '5' }]])('amount sai %j', async (payload) => {
  const res = await send(buildApp(), 'k1', payload);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'amount must be a positive integer' });
});
