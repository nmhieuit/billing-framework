import { expect, test } from 'vitest';
import { createRunner } from './ex10-bug-save-too-early.js';

test('lần đầu thành công, lần hai dùng lại kết quả', () => {
  const runner = createRunner();
  let calls = 0;
  expect(runner.run('k', () => ++calls)).toBe(1);
  expect(runner.run('k', () => ++calls)).toBe(1);
  expect(calls).toBe(1);
});

test('lần đầu thất bại thì lần sau được thử lại và trả kết quả thật', () => {
  const runner = createRunner();
  expect(() =>
    runner.run('k', () => {
      throw new Error('hỏng');
    }),
  ).toThrow('hỏng');
  expect(runner.run('k', () => 'thành công')).toBe('thành công');
});
