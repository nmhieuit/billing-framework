import { expect, test } from 'vitest';
import { createRunner } from './ex10-bug-save-too-early.js';

test('lần đầu thành công, lần hai dùng lại kết quả', () => {
  const runner = createRunner();
  let calls = 0;
  function work() {
    calls = calls + 1;
    return calls;
  }
  expect(runner.run('k', work)).toBe(1);
  expect(runner.run('k', work)).toBe(1); // dùng lại, không gọi work nữa
  expect(calls).toBe(1);
});

test('lần đầu thất bại thì lần sau được thử lại và trả kết quả thật', () => {
  const runner = createRunner();
  expect(() =>
    runner.run('k', () => {
      throw new Error('hỏng');
    }),
  ).toThrow('hỏng');
  // Lần sau cùng key vẫn được chạy lại bình thường
  expect(runner.run('k', () => 'thành công')).toBe('thành công');
});
