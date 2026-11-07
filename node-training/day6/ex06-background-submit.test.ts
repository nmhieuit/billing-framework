import { expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './ex06-background-submit.js';

// Gửi POST /topups giả lập (không cần mở cổng mạng thật)
async function postTopup(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/topups', payload: { amount: 100 } });
  return response;
}

// Gọi GET /topups/:id rồi lấy ra trường status
async function getStatus(app: FastifyInstance, id: string) {
  const response = await app.inject({ method: 'GET', url: `/topups/${id}` });
  const body = response.json();
  return body.status;
}

// Hàm log không làm gì, dùng khi test không quan tâm tới log
function ignoreLog(_line: string): void {}

test('trả 202 ngay khi submit còn đang chạy, sau đó cập nhật PENDING', async () => {
  // Tạo một Promise "treo": submit sẽ không xong cho đến khi ta gọi openGate()
  let openGate!: (value: 'created') => void;

  // Hàm được Promise gọi ngay; lưu resolve ra ngoài vào openGate để mở cổng sau
  function captureResolve(resolve: (value: 'created') => void): void {
    openGate = resolve;
  }
  const gate = new Promise<'created'>(captureResolve);

  // submit giả: trả về gate, nên không xong cho đến khi openGate() được gọi
  function submitWaitingForGate() {
    return gate;
  }

  const { app, drain } = buildApp({ submit: submitWaitingForGate, log: ignoreLog });

  // submit đang treo nhưng API vẫn phải trả 202 ngay
  const res = await postTopup(app);
  const resBody = res.json();
  expect(res.statusCode).toBe(202);
  expect(resBody).toEqual({ id: 't1', status: 'REQUESTED' });

  const statusBeforeOpen = await getStatus(app, 't1');
  expect(statusBeforeOpen).toBe('REQUESTED'); // chưa đổi vì submit chưa xong

  openGate('created'); // cho submit hoàn thành
  await drain(); // chờ job chạy nền xử lý xong kết quả

  const statusAfterOpen = await getStatus(app, 't1');
  expect(statusAfterOpen).toBe('PENDING');
});

test('unavailable: giữ REQUESTED', async () => {
  // submit giả: luôn trả 'unavailable'
  async function submitUnavailable() {
    return 'unavailable' as const;
  }

  const { app, drain } = buildApp({ submit: submitUnavailable, log: ignoreLog });

  await postTopup(app);
  await drain(); // chờ job nền chạy xong

  const status = await getStatus(app, 't1');
  expect(status).toBe('REQUESTED'); // không đổi trạng thái
});

test('submit ném lỗi: ghi log, giữ REQUESTED, không crash', async () => {
  const logs: string[] = []; // gom các dòng log để kiểm tra

  // submit giả: luôn ném lỗi
  async function submitThrows(): Promise<'created' | 'unavailable'> {
    throw new Error('network'); // giả lập submit bị lỗi
  }

  // log giả: ghi lại từng dòng vào mảng logs
  function recordLog(line: string): void {
    logs.push(line);
  }

  const { app, drain } = buildApp({ submit: submitThrows, log: recordLog });

  const res = await postTopup(app);
  expect(res.statusCode).toBe(202); // lỗi nền không ảnh hưởng response
  await drain();

  expect(logs).toEqual(['submit failed: network']); // lỗi được ghi log

  const status = await getStatus(app, 't1');
  expect(status).toBe('REQUESTED'); // trạng thái giữ nguyên
});

test('id tăng dần và 404 khi không có', async () => {
  // submit giả: luôn trả 'created'
  async function submitCreated() {
    return 'created' as const;
  }

  const { app, drain } = buildApp({ submit: submitCreated, log: ignoreLog });

  await postTopup(app); // t1
  const second = await postTopup(app); // t2
  const secondBody = second.json();
  expect(secondBody.id).toBe('t2');
  await drain();

  // id không tồn tại -> 404
  const missing = await app.inject({ method: 'GET', url: '/topups/zz' });
  expect(missing.statusCode).toBe(404);
});
