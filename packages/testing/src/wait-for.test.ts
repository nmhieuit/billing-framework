import { describe, expect, it } from 'vitest';
import { waitFor } from './wait-for.js';

describe('waitFor', () => {
  it('resolves as soon as the predicate becomes true', async () => {
    let calls = 0;
    await waitFor(() => ++calls >= 3, { intervalMs: 5, timeoutMs: 1000 });
    expect(calls).toBe(3);
  });

  it('supports async predicates', async () => {
    let ready = false;
    setTimeout(() => (ready = true), 20);
    await waitFor(async () => ready, { intervalMs: 5, timeoutMs: 1000 });
    expect(ready).toBe(true);
  });

  it('throws when the predicate never becomes true', async () => {
    await expect(waitFor(() => false, { intervalMs: 5, timeoutMs: 50 })).rejects.toThrow(
      /timed out/i,
    );
  });
});
