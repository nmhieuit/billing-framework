import { describe, expect, it } from 'vitest';
import { createPrng, resolveSeed } from './prng.js';

// Cài đặt mulberry32 tham chiếu độc lập để so khớp dãy chính xác.
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function take(next: () => number, n: number): number[] {
  return Array.from({ length: n }, () => next());
}

describe('createPrng', () => {
  it('cùng seed cho đúng dãy mulberry32 tham chiếu', () => {
    const prng = createPrng(12345);
    const ref = referenceMulberry32(12345);
    expect(take(() => prng.next(), 10)).toEqual(take(ref, 10));
  });

  it('seed khác cho dãy khác', () => {
    expect(createPrng(1).next()).not.toBe(createPrng(2).next());
  });

  it('next luôn trong [0, 1)', () => {
    const prng = createPrng(7);
    for (const v of take(() => prng.next(), 1000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int nằm trong khoảng đóng và chạm cả hai đầu mút', () => {
    const prng = createPrng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const v = prng.int(3, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('int(min, min) luôn trả min', () => {
    expect(createPrng(5).int(4, 4)).toBe(4);
  });

  it('chance(0) luôn sai, chance(1) luôn đúng', () => {
    const prng = createPrng(3);
    for (let i = 0; i < 100; i += 1) {
      expect(prng.chance(0)).toBe(false);
      expect(prng.chance(1)).toBe(true);
    }
  });

  it('chance(p) = next() < p theo đúng dãy', () => {
    const prng = createPrng(42);
    const ref = referenceMulberry32(42);
    for (let i = 0; i < 50; i += 1) {
      expect(prng.chance(0.3)).toBe(ref() < 0.3);
    }
  });

  it('pick chọn phần tử theo chỉ số xác định và ném lỗi khi rỗng', () => {
    const items = ['a', 'b', 'c', 'd'] as const;
    const prng = createPrng(8);
    const ref = referenceMulberry32(8);
    for (let i = 0; i < 20; i += 1) {
      expect(prng.pick(items)).toBe(items[Math.floor(ref() * items.length)]);
    }
    expect(() => createPrng(1).pick([])).toThrow();
  });

  it('int ném lỗi khi min > max và chấp nhận min == max', () => {
    expect(() => createPrng(1).int(5, 4)).toThrow(/min/);
    expect(createPrng(1).int(5, 5)).toBe(5);
  });

  it('fork(label) ổn định, độc lập với mức tiêu thụ của cha, và khác nhãn khác dãy', () => {
    const a1 = createPrng(100).fork('a');
    const parent = createPrng(100);
    parent.next();
    parent.next();
    const a2 = parent.fork('a');
    const b = createPrng(100).fork('b');
    const seqA1 = take(() => a1.next(), 8);
    expect(take(() => a2.next(), 8)).toEqual(seqA1);
    expect(take(() => b.next(), 8)).not.toEqual(seqA1);
  });

  it('fork không làm đổi dãy của cha', () => {
    const parent = createPrng(5);
    const ref = referenceMulberry32(5);
    parent.fork('x').next();
    expect(take(() => parent.next(), 5)).toEqual(take(ref, 5));
  });

  it('fork phụ thuộc seed của cha', () => {
    expect(createPrng(1).fork('a').next()).not.toBe(createPrng(2).fork('a').next());
  });
});

describe('resolveSeed', () => {
  it('chấp nhận CHAOS_SEED hợp lệ gồm biên 0 và 2^32-1', () => {
    expect(resolveSeed({ CHAOS_SEED: '12345' })).toBe(12345);
    expect(resolveSeed({ CHAOS_SEED: '0' })).toBe(0);
    expect(resolveSeed({ CHAOS_SEED: '4294967295' })).toBe(4294967295);
  });

  it('không đặt hoặc rỗng thì sinh seed ngẫu nhiên hợp lệ', () => {
    for (const env of [{}, { CHAOS_SEED: '' }]) {
      const seed = resolveSeed(env);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(4294967295);
    }
  });

  it('không đặt hoặc rỗng thì dùng seed mặc định cho trước; đặt sai vẫn ném lỗi (không rơi về mặc định)', () => {
    expect(resolveSeed({}, 1)).toBe(1);
    expect(resolveSeed({ CHAOS_SEED: '' }, 1)).toBe(1);
    expect(resolveSeed({ CHAOS_SEED: '7' }, 1)).toBe(7);
    expect(() => resolveSeed({ CHAOS_SEED: 'abc' }, 1)).toThrow(/CHAOS_SEED/);
  });

  it.each(['abc', '-1', '1.5', '4294967296', '1e3', '0x10', ' 5', '5 '])(
    'từ chối CHAOS_SEED sai định dạng: %j',
    (value) => {
      expect(() => resolveSeed({ CHAOS_SEED: value })).toThrow(/CHAOS_SEED/);
    },
  );
});
