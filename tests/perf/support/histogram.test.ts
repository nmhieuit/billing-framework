import { describe, expect, it } from 'vitest';
import { percentile, summarizeLatencies } from './histogram.js';

const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

describe('percentile (nearest-rank)', () => {
  it('1..100 cho p50=50, p95=95, p99=99, p100=100', () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it('p0 trả phần tử nhỏ nhất', () => {
    expect(percentile([7, 3, 9], 0)).toBe(3);
  });

  it('một phần tử: mọi p đều trả chính nó', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('nhận mảng chưa sắp xếp', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 80)).toBe(4);
  });

  it('mảng rỗng trả NaN', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('không sửa mảng đầu vào', () => {
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });

  it('p ngoài [0,100] hoặc không hữu hạn thì ném lỗi', () => {
    expect(() => percentile([1], -1)).toThrow();
    expect(() => percentile([1], 100.5)).toThrow();
    expect(() => percentile([1], Number.NaN)).toThrow();
    expect(() => percentile([], 101)).toThrow();
  });
});

describe('summarizeLatencies', () => {
  it('tính đúng count, mean, max và các phân vị', () => {
    expect(summarizeLatencies(oneToHundred)).toEqual({
      count: 100,
      mean: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it('mảng rỗng: count 0, các số khác NaN', () => {
    const s = summarizeLatencies([]);
    expect(s.count).toBe(0);
    expect(s.mean).toBeNaN();
    expect(s.p99).toBeNaN();
    expect(s.max).toBeNaN();
  });

  it('không sửa mảng đầu vào', () => {
    const input = [9, 1, 5];
    summarizeLatencies(input);
    expect(input).toEqual([9, 1, 5]);
  });
});
