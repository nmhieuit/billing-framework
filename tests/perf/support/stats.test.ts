import { describe, expect, it } from 'vitest';
import { median, range } from './stats.js';

describe('median', () => {
  it('số phần tử lẻ: phần tử giữa', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it('số phần tử chẵn: trung bình hai phần tử giữa', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('không bị kéo lệch bởi giá trị ngoại lai (khác trung bình)', () => {
    expect(median([1, 2, 1000])).toBe(2);
  });

  it('rỗng trả NaN và không sửa mảng đầu vào', () => {
    expect(median([])).toBeNaN();
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('range', () => {
  it('trả min và max', () => {
    expect(range([3, -1, 8, 2])).toEqual({ min: -1, max: 8 });
  });

  it('một phần tử', () => {
    expect(range([5])).toEqual({ min: 5, max: 5 });
  });

  it('rỗng trả NaN cho cả hai', () => {
    const r = range([]);
    expect(r.min).toBeNaN();
    expect(r.max).toBeNaN();
  });
});
