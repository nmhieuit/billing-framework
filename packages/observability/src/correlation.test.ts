import { describe, expect, it } from 'vitest';
import { getCorrelationId, resolveCorrelationId, runWithCorrelation } from './index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('correlation context', () => {
  it('is undefined outside a context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('propagates across awaits inside a context', async () => {
    const seen = await runWithCorrelation('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCorrelationId();
    });
    expect(seen).toBe('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02');
  });

  it('keeps concurrent contexts isolated', async () => {
    const run = (id: string) =>
      runWithCorrelation(id, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return getCorrelationId();
      });
    const a = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const b = '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01';
    expect(await Promise.all([run(a), run(b)])).toEqual([a, b]);
  });
});

describe('resolveCorrelationId', () => {
  it('reuses a valid incoming uuid', () => {
    expect(resolveCorrelationId('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02')).toBe(
      '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
    );
  });

  it.each([undefined, '', 'not-a-uuid', ['3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02', 'x']])(
    'generates a fresh uuid for %j',
    (incoming) => {
      expect(resolveCorrelationId(incoming as string | undefined)).toMatch(UUID);
    },
  );
});
