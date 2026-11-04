import { expect, test } from 'vitest';
import { sleep } from './ex02-sleep.js';

test('chờ đủ thời gian', async () => {
  // Ghi lại giờ bắt đầu (mili-giây), chờ 100ms, rồi đo thời gian đã trôi qua
  const start = Date.now();
  await sleep(100);
  // Cho sai số nhỏ vì đồng hồ hệ thống không tuyệt đối chính xác
  expect(Date.now() - start).toBeGreaterThanOrEqual(95);
});

test('trả về Promise', () => {
  expect(sleep(1)).toBeInstanceOf(Promise);
});
