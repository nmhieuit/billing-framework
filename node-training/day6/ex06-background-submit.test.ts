import { expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './ex06-background-submit.js';

// Gửi POST /topups giả lập (không cần mở cổng mạng thật)
async function postTopup(app: FastifyInstance) {
  return app.inject({ method: 'POST', url: '/topups', payload: { amount: 100 } });
}

// Gọi GET /topups/:id rồi lấy ra trường status
async function getStatus(app: FastifyInstance, id: string) {
  const res = await app.inject({ method: 'GET', url: `/topups/${id}` });
  return res.json().status;
}

test('trả 202 ngay khi submit còn đang chạy, sau đó cập nhật PENDING', async () => {
  // Tạo một Promise "treo": submit sẽ không xong cho đến khi ta gọi openGate()
  let openGate!: (value: 'created') => void;
  const gate = new Promise<'created'>((resolve) => {
    openGate = resolve;
  });

  const { app, drain } = buildApp({ submit: () => gate, log: () => {} });

  // submit đang treo nhưng API vẫn phải trả 202 ngay
  const res = await postTopup(app);
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ id: 't1', status: 'REQUESTED' });
  expect(await getStatus(app, 't1')).toBe('REQUESTED'); // chưa đổi vì submit chưa xong

  openGate('created'); // cho submit hoàn thành
  await drain(); // chờ job chạy nền xử lý xong kết quả
  expect(await getStatus(app, 't1')).toBe('PENDING');
});

test('unavailable: giữ REQUESTED', async () => {
  const { app, drain } = buildApp({ submit: async () => 'unavailable', log: () => {} });

  await postTopup(app);
  await drain(); // chờ job nền chạy xong

  expect(await getStatus(app, 't1')).toBe('REQUESTED'); // không đổi trạng thái
});

test('submit ném lỗi: ghi log, giữ REQUESTED, không crash', async () => {
  const logs: string[] = []; // gom các dòng log để kiểm tra
  const { app, drain } = buildApp({
    submit: async () => {
      throw new Error('network'); // giả lập submit bị lỗi
    },
    log: (line) => logs.push(line),
  });

  const res = await postTopup(app);
  expect(res.statusCode).toBe(202); // lỗi nền không ảnh hưởng response
  await drain();

  expect(logs).toEqual(['submit failed: network']); // lỗi được ghi log
  expect(await getStatus(app, 't1')).toBe('REQUESTED'); // trạng thái giữ nguyên
});

test('id tăng dần và 404 khi không có', async () => {
  const { app, drain } = buildApp({ submit: async () => 'created', log: () => {} });

  await postTopup(app); // t1
  const second = await postTopup(app); // t2
  expect(second.json().id).toBe('t2');
  await drain();

  // id không tồn tại -> 404
  const missing = await app.inject({ method: 'GET', url: '/topups/zz' });
  expect(missing.statusCode).toBe(404);
});
