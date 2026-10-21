import { expect, test } from 'vitest';
import { buildApp } from './ex06-background-submit.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const post = (app: ReturnType<typeof buildApp>['app'], amount = 100) =>
  app.inject({ method: 'POST', url: '/topups', payload: { amount } });
const status = async (app: ReturnType<typeof buildApp>['app'], id: string) =>
  (await app.inject({ method: 'GET', url: `/topups/${id}` })).json().status;

test('trả 202 ngay khi submit còn đang chạy, sau đó cập nhật PENDING', async () => {
  const gate = deferred<'created'>();
  const { app, drain } = buildApp({ submit: () => gate.promise, log: () => {} });

  const res = await post(app);
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ id: 't1', status: 'REQUESTED' });
  expect(await status(app, 't1')).toBe('REQUESTED');

  gate.resolve('created');
  await drain();
  expect(await status(app, 't1')).toBe('PENDING');
});

test('unavailable: giữ REQUESTED', async () => {
  const { app, drain } = buildApp({ submit: async () => 'unavailable', log: () => {} });
  await post(app);
  await drain();
  expect(await status(app, 't1')).toBe('REQUESTED');
});

test('submit ném lỗi: ghi log, giữ REQUESTED, không crash', async () => {
  const lines: string[] = [];
  const { app, drain } = buildApp({
    submit: async () => {
      throw new Error('network');
    },
    log: (line) => lines.push(line),
  });
  const res = await post(app);
  expect(res.statusCode).toBe(202);
  await drain();
  expect(lines).toEqual(['submit failed: network']);
  expect(await status(app, 't1')).toBe('REQUESTED');
});

test('id tăng dần và 404 khi không có', async () => {
  const { app, drain } = buildApp({ submit: async () => 'created', log: () => {} });
  await post(app);
  expect((await post(app)).json().id).toBe('t2');
  await drain();
  expect((await app.inject({ method: 'GET', url: '/topups/zz' })).statusCode).toBe(404);
});
