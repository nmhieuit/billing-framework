import { expect, test } from 'vitest';
import { buildApp } from './ex01-health.js';

test('GET /health', async () => {
  // inject: giả lập một request gửi tới app (không cần mở cổng mạng thật)
  const res = await buildApp().inject({ method: 'GET', url: '/health' });
  // statusCode: mã trạng thái HTTP của response
  expect(res.statusCode).toBe(200);
  // res.json(): đọc body của response và đổi từ JSON thành đối tượng
  expect(res.json()).toEqual({ status: 'ok' });
});
