import { expect, test } from 'vitest';
import { createIdempotencyStore } from './ex05-idempotency-store.js';

test('key mới: chạy work', () => {
  const store = createIdempotencyStore();
  expect(store.run('k1', 'a', () => 'ket-qua')).toEqual({ result: 'ket-qua', replayed: false });
});

test('cùng key và nội dung: không chạy lại work', () => {
  const store = createIdempotencyStore();
  let calls = 0;
  const work = () => ++calls;
  expect(store.run('k1', 'a', work)).toEqual({ result: 1, replayed: false });
  expect(store.run('k1', 'a', work)).toEqual({ result: 1, replayed: true });
  expect(calls).toBe(1);
});

test('cùng key khác nội dung: lỗi', () => {
  const store = createIdempotencyStore();
  store.run('k1', 'a', () => 1);
  expect(() => store.run('k1', 'b', () => 2)).toThrow('IDEMPOTENCY_KEY_REUSED');
});

test('key khác nhau độc lập', () => {
  const store = createIdempotencyStore();
  store.run('k1', 'a', () => 1);
  expect(store.run('k2', 'a', () => 2)).toEqual({ result: 2, replayed: false });
});
