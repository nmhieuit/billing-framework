import { afterEach, describe, expect, it, vi } from 'vitest';
import { raceTimeout } from './crash.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('raceTimeout', () => {
  it('work thắng: trả true và không để lại timer nào', async () => {
    vi.useFakeTimers();
    await expect(raceTimeout(Promise.resolve(true), 10_000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hết giờ: trả false', async () => {
    vi.useFakeTimers();
    const pending = raceTimeout(new Promise<true>(() => undefined), 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
