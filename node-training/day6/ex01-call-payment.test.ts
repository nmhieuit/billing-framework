import { afterEach, expect, test } from 'vitest';
import { callPayment } from './ex01-call-payment.js';
import { type FakePayment, startFakePayment } from './support/fake-payment.js';

// payment giả đang chạy (nếu có). Sau mỗi test sẽ tắt nó đi
let payment: FakePayment | undefined;

// Chạy sau MỖI test: tắt payment giả để test sau không bị ảnh hưởng.
// Dấu ?. nghĩa là: nếu payment chưa được tạo (undefined) thì bỏ qua, không gọi close().
afterEach(async () => {
  await payment?.close();
});

test('payment ok -> chargeId', async () => {
  // Khởi động payment giả; kịch bản ['ok'] nghĩa là luôn trả thành công
  payment = await startFakePayment(['ok']);

  // Địa chỉ của payment giả vừa khởi động (cổng được cấp ngẫu nhiên)
  const paymentUrl = payment.url;

  // Gọi hàm cần test với số tiền 100
  const chargeId = await callPayment(paymentUrl, 100);

  // Kỳ vọng: payment giả trả về chargeId đầu tiên là 'ch_1'
  expect(chargeId).toBe('ch_1');

  // Số lần payment giả bị gọi
  const callCount = payment.calls();

  // payment chỉ bị gọi đúng 1 lần
  expect(callCount).toBe(1);
});

test('payment trả 500 -> lỗi có mã trạng thái', async () => {
  // Kịch bản ['error']: payment giả trả mã 500
  payment = await startFakePayment(['error']);

  const paymentUrl = payment.url;

  // Chưa await: lấy Promise đang chờ kết quả để kiểm tra nó bị từ chối (reject)
  const callPromise = callPayment(paymentUrl, 100);

  // Kỳ vọng: Promise bị reject với lỗi có nội dung chứa 'payment responded 500'
  await expect(callPromise).rejects.toThrow('payment responded 500');
});
