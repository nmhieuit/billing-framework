import { afterEach, expect, test } from 'vitest';
import { ping } from './ex09-bug-no-timeout.js';
import { type FakePayment, startFakePayment } from './support/fake-payment.js';

// payment giả đang chạy (nếu có). Sau mỗi test sẽ tắt nó đi
let payment: FakePayment | undefined;

// Chạy sau MỖI test: tắt payment giả để test sau không bị ảnh hưởng.
// Dấu ?. nghĩa là: nếu payment chưa được tạo (undefined) thì bỏ qua, không gọi close().
afterEach(async () => {
  await payment?.close();
});

test('payment nhanh -> ok', async () => {
  // Kịch bản ['ok']: payment giả trả lời ngay
  payment = await startFakePayment(['ok']);
  const paymentUrl = payment.url;

  const result = await ping(paymentUrl, 500);

  expect(result).toBe('ok');
});

test('payment chậm -> timeout, và trả về sớm (< 800ms)', async () => {
  // payment chậm 1500ms nhưng chỉ cho phép chờ 200ms
  payment = await startFakePayment(['slow'], 1500);
  const paymentUrl = payment.url;

  // Ghi lại thời điểm bắt đầu để đo thời gian hàm chạy
  const startTime = Date.now();

  const result = await ping(paymentUrl, 200);

  // Thời gian thực tế đã trôi qua (mili-giây)
  const elapsedMs = Date.now() - startTime;

  expect(result).toBe('timeout');
  expect(elapsedMs).toBeLessThan(800);
});
