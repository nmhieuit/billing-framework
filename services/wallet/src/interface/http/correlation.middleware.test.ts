import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { getCorrelationId } from '@billing/observability';
import { CorrelationMiddleware } from './correlation.middleware.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(headers: Record<string, string>) {
  const set: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (set[k] = v) } as unknown as ServerResponse;
  let seen: string | undefined;
  new CorrelationMiddleware().use({ headers } as IncomingMessage, res, () => {
    seen = getCorrelationId();
  });
  return { header: set['x-correlation-id'], seen };
}

describe('CorrelationMiddleware', () => {
  it('generates an id, sets the header and exposes it to downstream code', () => {
    const { header, seen } = run({});
    expect(header).toMatch(UUID);
    expect(seen).toBe(header);
  });

  it('reuses a valid incoming id', () => {
    const id = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const { header, seen } = run({ 'x-correlation-id': id });
    expect(header).toBe(id);
    expect(seen).toBe(id);
  });
});
