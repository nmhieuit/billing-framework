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
    const charges = new Set(Array.from({ length: 50 }, () => ids.chargeId()));
    expect(charges.size).toBe(50);
    for (const id of charges) expect(id).toMatch(/^ch_[0-9a-f]{32}$/);
    expect(ids.eventId()).toMatch(/^evt_[0-9a-f]{32}$/);
  });
});
