import { describe, expect, it, vi } from 'vitest';
import { drainBatches } from './drain.js';

describe('drainBatches', () => {
  it.each([0, -1, 1.5, Number.NaN])(
    'rejects batchSize %s without calling step',
    async (batchSize) => {
      const step = vi.fn(async () => 0);
      await expect(drainBatches(step, { batchSize })).rejects.toThrow(
        /batchSize must be an integer/,
      );
      expect(step).not.toHaveBeenCalled();
    },
  );

  it('keeps going while batches are full and stops on the first short batch', async () => {
    const results = [1000, 1000, 400];
    const step = vi.fn(async () => results.shift() ?? 0);
    expect(await drainBatches(step, { batchSize: 1000 })).toBe(2400);
    expect(step).toHaveBeenCalledTimes(3);
    expect(step).toHaveBeenCalledWith(1000);
  });

  it('does a single call when nothing is eligible', async () => {
    const step = vi.fn(async () => 0);
    expect(await drainBatches(step, { batchSize: 10 })).toBe(0);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('stops before the next call once shouldContinue turns false', async () => {
    let calls = 0;
    const step = vi.fn(async () => {
      calls += 1;
      return 5;
    });
    const total = await drainBatches(step, { batchSize: 5, shouldContinue: () => calls < 3 });
    expect(total).toBe(15);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('never calls step when it may not continue at the start', async () => {
    const step = vi.fn(async () => 1);
    expect(await drainBatches(step, { batchSize: 1, shouldContinue: () => false })).toBe(0);
    expect(step).not.toHaveBeenCalled();
  });

  it('propagates a failing step', async () => {
    const step = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(drainBatches(step, { batchSize: 1 })).rejects.toThrow('boom');
  });
});
