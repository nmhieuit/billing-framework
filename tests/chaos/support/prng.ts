import { randomInt } from 'node:crypto';

export interface Prng {
  next(): number;
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  fork(label: string): Prng;
}

const MAX_SEED = 0xffffffff;

// Băm FNV-1a 32 bit để suy ra seed con từ (seed, label).
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// PRNG mulberry32: nhanh, xác định hoàn toàn theo seed.
export function createPrng(seed: number): Prng {
  const rootSeed = seed >>> 0;
  let state = rootSeed;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min, max) {
      if (min > max) throw new Error(`int: min (${min}) lớn hơn max (${max})`);
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('pick: danh sách rỗng');
      return items[Math.floor(next() * items.length)] as T;
    },
    // Dòng con chỉ phụ thuộc (seed gốc, label), không phụ thuộc mức tiêu thụ của cha.
    fork(label) {
      return createPrng(fnv1a(`${rootSeed}:${label}`));
    },
  };
}

// CHAOS_SEED hợp lệ là số nguyên thập phân 0..2^32-1; không đặt thì dùng `defaultSeed` (nếu có) hoặc chọn ngẫu nhiên.
// Giá trị đặt mà không hợp lệ luôn ném lỗi (không bao giờ lặng lẽ rơi về seed khác).
export function resolveSeed(env: NodeJS.ProcessEnv, defaultSeed?: number): number {
  const raw = env.CHAOS_SEED;
  if (raw === undefined || raw === '') return defaultSeed ?? randomInt(0, MAX_SEED);
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_SEED) {
    throw new Error(
      `CHAOS_SEED không hợp lệ: ${JSON.stringify(raw)} (cần số nguyên 0..${MAX_SEED})`,
    );
  }
  return Number(raw);
}
