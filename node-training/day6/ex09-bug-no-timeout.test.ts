import { afterEach, expect, test } from 'vitest';
import { ping } from './ex09-bug-no-timeout.js';
import { type FakePayment, startFakePayment } from './support/fake-payment.js';

let payment: FakePayment | undefined;
afterEach(async () => payment?.close());

test('payment nhanh -> ok', async () => {
  payment = await startFakePayment(['ok']);
  expect(await ping(payment.url, 500)).toBe('ok');
});

test('payment chậm -> timeout, và trả về sớm (< 800ms)', async () => {
  payment = await startFakePayment(['slow'], 1500);
  const start = Date.now();
  expect(await ping(payment.url, 200)).toBe('timeout');
  expect(Date.now() - start).toBeLessThan(800);
});
