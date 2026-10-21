import { expect, test } from 'vitest';
import { buildApp } from './d-app.js';

const send = (app: ReturnType<typeof buildApp>, key: string, amount: number) =>
  app.inject({ method: 'POST', url: '/topups', headers: { 'idempotency-key': key }, payload: { amount } });

test('gửi lại cùng key và cùng nội dung: không cộng tiền hai lần', async () => {
  const app = buildApp();
  const first = await send(app, 'k1', 100);
  const second = await send(app, 'k1', 100);
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(201);
  expect(second.json()).toEqual({ balance: 100 });
  expect(second.headers['idempotent-replayed']).toBe('true');
});

test('cùng key nhưng khác nội dung: 422', async () => {
  const app = buildApp();
  await send(app, 'k1', 100);
  expect((await send(app, 'k1', 999)).statusCode).toBe(422);
});
