// test: khai báo một bài kiểm tra; expect: so sánh kết quả với giá trị mong đợi
import { expect, test } from 'vitest';
// Import hàm cần kiểm tra từ file bài làm
import { greet } from './ex01-greet.js';

test('chào một người', () => {
  // toBe: kết quả phải đúng bằng giá trị này
  expect(greet('An')).toBe('Xin chào, An!');
});

test('chào người khác', () => {
  expect(greet('Bình')).toBe('Xin chào, Bình!');
});
