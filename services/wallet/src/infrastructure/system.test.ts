import { describe, expect, it } from 'vitest';
import { RandomIdGenerator, SystemClock } from './system.js';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('RandomIdGenerator', () => {
  it('produces prefixed, unique identifiers', () => {
    const ids = new RandomIdGenerator();
    const topups = new Set(Array.from({ length: 50 }, () => ids.topupId()));
    expect(topups.size).toBe(50);
    for (const id of topups) expect(id).toMatch(/^tp_[0-9a-f]{32}$/);
    expect(ids.transactionId()).toMatch(/^tx_[0-9a-f]{32}$/);
  });
});
