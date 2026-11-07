import { afterEach, expect, test } from 'vitest';
import { createCharge } from './ex02-gateway.js';
import { type FakePayment, startFakePayment } from './support/fake-payment.js';

// payment giả đang chạy (nếu có). Sau mỗi test sẽ tắt nó đi
let payment: FakePayment | undefined;

// Chạy sau MỖI test: tắt payment giả để test sau không bị ảnh hưởng.
// Dấu ?. nghĩa là: nếu payment chưa được tạo (undefined) thì bỏ qua, không gọi close().
afterEach(async () => {
  await payment?.close();
});

test('202 -> created', async () => {
  // Kịch bản ['ok']: payment giả trả 202
  payment = await startFakePayment(['ok']);
  const paymentUrl = payment.url;

  // Gọi hàm cần test với số tiền 100, timeout 500ms
  const result = await createCharge(paymentUrl, 100, 500);

  // Kỳ vọng: created kèm chargeId đầu tiên 'ch_1'
  expect(result).toEqual({ outcome: 'created', chargeId: 'ch_1' });
});

test('422 -> rejected', async () => {
  // Kịch bản ['reject']: payment giả trả 422
  payment = await startFakePayment(['reject']);
  const paymentUrl = payment.url;

  const result = await createCharge(paymentUrl, 100, 500);

  // Kỳ vọng: rejected kèm mã 422
  expect(result).toEqual({ outcome: 'rejected', status: 422 });
});

test('500 -> unavailable', async () => {
  // Kịch bản ['error']: payment giả trả 500
  payment = await startFakePayment(['error']);
  const paymentUrl = payment.url;

  const result = await createCharge(paymentUrl, 100, 500);

  // Kỳ vọng: 5xx được coi là unavailable (có thể thử lại)
  expect(result).toEqual({ outcome: 'unavailable' });
});

test('payment chậm hơn timeout -> unavailable, và trả về sớm', async () => {
  // payment chậm 1500ms nhưng ta chỉ chờ 200ms
  payment = await startFakePayment(['slow'], 1500);
  const paymentUrl = payment.url;

  // Ghi lại thời điểm bắt đầu để đo thời gian hàm chạy
  const startTime = Date.now();

  const result = await createCharge(paymentUrl, 100, 200);

  // Thời gian thực tế đã trôi qua (mili-giây)
  const elapsedMs = Date.now() - startTime;

  // Kỳ vọng: timeout được coi là unavailable
  expect(result).toEqual({ outcome: 'unavailable' });

  // Không phải chờ hết 1500ms
  expect(elapsedMs).toBeLessThan(1000);
});

test('không kết nối được -> unavailable', async () => {
  // Cổng 1 không có server nào lắng nghe
  const unreachableUrl = 'http://127.0.0.1:1';

  const result = await createCharge(unreachableUrl, 100, 500);

  // Kỳ vọng: lỗi mạng được coi là unavailable, hàm không ném lỗi
  expect(result).toEqual({ outcome: 'unavailable' });
});
