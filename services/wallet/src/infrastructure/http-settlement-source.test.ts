import { describe, expect, it } from 'vitest';
import { ReconciliationTooLargeError, SettlementUnavailableError } from '../application/errors.js';
import { HttpSettlementSource } from './http-settlement-source.js';

const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  chargeId: `ch_${n}`,
  reference: `tp_${n}`,
  amount: 1000 * n,
  currency: 'VND',
  status: 'SUCCEEDED',
  metadata: { tenantId: 'acme' },
  completedAt: '2026-10-10T01:00:00.000Z',
  ...overrides,
});
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function build(handler: (url: URL, call: number) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url, urls.length);
  }) as typeof fetch;
  return {
    urls,
    source: new HttpSettlementSource({
      baseUrl: 'http://payment:3002',
      timeoutMs: 1000,
      fetchImpl: impl,
    }),
  };
}

describe('HttpSettlementSource', () => {
  it('reads one page and maps the charges', async () => {
    const { source, urls } = build(() =>
      json({
        date: '2026-10-10',
        items: [item(1), item(2, { status: 'FAILED', metadata: undefined })],
        nextCursor: null,
        totals: [],
      }),
    );
    expect(await source.fetchDay('2026-10-10', 100)).toEqual([
      {
        chargeId: 'ch_1',
        reference: 'tp_1',
        amount: 1000,
        currency: 'VND',
        status: 'SUCCEEDED',
        tenantId: 'acme',
      },
      {
        chargeId: 'ch_2',
        reference: 'tp_2',
        amount: 2000,
        currency: 'VND',
        status: 'FAILED',
        tenantId: null,
      },
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/settlements');
    expect(urls[0]?.searchParams.get('date')).toBe('2026-10-10');
    expect(urls[0]?.searchParams.get('limit')).toBe('1000');
    expect(urls[0]?.searchParams.has('cursor')).toBe(false);
  });

  it('follows nextCursor across pages', async () => {
    const { source, urls } = build((_url, call) =>
      call === 1
        ? json({ items: [item(1)], nextCursor: 'abc+/=', totals: [] })
        : json({ items: [item(2)], nextCursor: null, totals: [] }),
    );
    const charges = await source.fetchDay('2026-10-10', 100);
    expect(charges.map((c) => c.chargeId)).toEqual(['ch_1', 'ch_2']);
    expect(urls[1]?.searchParams.get('cursor')).toBe('abc+/=');
  });

  it('fails with SettlementUnavailableError on HTTP errors, network errors and malformed bodies', async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => json({ error: { code: 'X' } }, 500),
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      () => json({ nope: true }),
      () => json({ items: [item(1, { amount: 1.5 })], nextCursor: null }),
      () => json({ items: [item(1, { status: 'PENDING' })], nextCursor: null }),
      () => json({ items: [item(1, { chargeId: '' })], nextCursor: null }),
      () => json({ items: [item(1, { chargeId: 'c'.repeat(65) })], nextCursor: null }),
      () => json({ items: [item(1, { reference: 'r'.repeat(65) })], nextCursor: null }),
      () => json({ items: [item(1, { currency: 'VNDX' })], nextCursor: null }),
      () => json({ items: [item(1, { currency: 'VN' })], nextCursor: null }),
      () => json({ items: [item(1)], nextCursor: '' }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const handler of cases) {
      await expect(build(handler).source.fetchDay('2026-10-10', 100)).rejects.toBeInstanceOf(
        SettlementUnavailableError,
      );
    }
  });

  it('fails with ReconciliationTooLargeError once the charge count passes the limit', async () => {
    const { source } = build(() => json({ items: [item(1), item(2), item(3)], nextCursor: null }));
    await expect(source.fetchDay('2026-10-10', 2)).rejects.toBeInstanceOf(
      ReconciliationTooLargeError,
    );
    expect(await source.fetchDay('2026-10-10', 3)).toHaveLength(3);
  });

  it('fails fast instead of looping when the cursor does not advance', async () => {
    const { source, urls } = build(() => json({ items: [item(1)], nextCursor: 'same' }));
    await expect(source.fetchDay('2026-10-10', 100)).rejects.toBeInstanceOf(
      SettlementUnavailableError,
    );
    expect(urls).toHaveLength(2);
  });

  it('fails when a page is empty but still carries a cursor', async () => {
    const { source, urls } = build(() => json({ items: [], nextCursor: 'X' }));
    await expect(source.fetchDay('2026-10-10', 100)).rejects.toBeInstanceOf(
      SettlementUnavailableError,
    );
    expect(urls).toHaveLength(1);
  });

  it('fails when the page count exceeds ceil(maxCharges / page limit) + 1', async () => {
    // maxCharges = 100 => tối đa 2 trang; mỗi trang có cursor mới nhưng chỉ 1 charge.
    const { source, urls } = build((_url, call) =>
      json({ items: [item(call)], nextCursor: `c${call}` }),
    );
    await expect(source.fetchDay('2026-10-10', 100)).rejects.toBeInstanceOf(
      SettlementUnavailableError,
    );
    expect(urls).toHaveLength(2);
  });
});
