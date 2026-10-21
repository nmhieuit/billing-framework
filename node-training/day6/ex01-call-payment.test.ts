import { afterEach, expect, test } from 'vitest';
import { callPayment } from './ex01-call-payment.js';
import { type FakePayment, startFakePayment } from './support/fake-payment.js';

let payment: FakePayment | undefined;
afterEach(async () => payment?.close());

test('payment ok -> chargeId', async () => {
  payment = await startFakePayment(['ok']);
  expect(await callPayment(payment.url, 100)).toBe('ch_1');
  expect(payment.calls()).toBe(1);
});

test('payment trả 500 -> lỗi có mã trạng thái', async () => {
  payment = await startFakePayment(['error']);
  await expect(callPayment(payment.url, 100)).rejects.toThrow('payment responded 500');
});
