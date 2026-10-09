import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('starts at the given instant and does not move by itself', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.123Z');
    expect(clock.now().toISOString()).toBe('2026-10-09T10:00:00.123Z');
    expect(clock.now().toISOString()).toBe('2026-10-09T10:00:00.123Z');
  });

  it('advances by milliseconds and seconds', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.000Z');
    clock.advance(1);
    clock.advanceSeconds(2);
    expect(clock.now().toISOString()).toBe('2026-10-09T10:00:02.001Z');
  });

  it('can be set to an absolute instant', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.000Z');
    clock.set(new Date('2026-10-10T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('returns copies so callers cannot mutate the clock', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.000Z');
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
