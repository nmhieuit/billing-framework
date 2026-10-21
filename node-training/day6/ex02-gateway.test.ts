import { afterEach, expect, test } from 'vitest';
import { createCharge } from './ex02-gateway.js';
import { type FakePayment, startFakePayment } from './support/fake-payment.js';

let payment: FakePayment | undefined;
afterEach(async () => payment?.close());

test('202 -> created', async () => {
  payment = await startFakePayment(['ok']);
  expect(await createCharge(payment.url, 100, 500)).toEqual({ outcome: 'created', chargeId: 'ch_1' });
});

test('422 -> rejected', async () => {
  payment = await startFakePayment(['reject']);
  expect(await createCharge(payment.url, 100, 500)).toEqual({ outcome: 'rejected', status: 422 });
});

test('500 -> unavailable', async () => {
  payment = await startFakePayment(['error']);
  expect(await createCharge(payment.url, 100, 500)).toEqual({ outcome: 'unavailable' });
});

test('payment chậm hơn timeout -> unavailable, và trả về sớm', async () => {
  payment = await startFakePayment(['slow'], 1500);
  const start = Date.now();
  expect(await createCharge(payment.url, 100, 200)).toEqual({ outcome: 'unavailable' });
  expect(Date.now() - start).toBeLessThan(1000);
});

test('không kết nối được -> unavailable', async () => {
  expect(await createCharge('http://127.0.0.1:1', 100, 500)).toEqual({ outcome: 'unavailable' });
});
