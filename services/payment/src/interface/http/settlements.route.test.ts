import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidSettlementQueryError } from '../../application/errors.js';
import type { SettlementQuery, SettlementView } from '../../application/get-settlement.js';
import { buildApp, type AppDependencies } from './app.js';
import { stubDeps } from './stub-deps.js';

const view: SettlementView = { date: '2026-10-10', items: [], nextCursor: null, totals: [] };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<AppDependencies>): Promise<FastifyInstance> {
  app = await buildApp(stubDeps(overrides));
  return app;
}

describe('GET /settlements', () => {
  it('forwards date, limit and cursor and returns the settlement', async () => {
    const execute = vi.fn<(query: SettlementQuery) => Promise<SettlementView>>(async () => view);
    const server = await start({ getSettlement: { execute } });
    const res = await server.inject({
      method: 'GET',
      url: '/settlements?date=2026-10-10&limit=2&cursor=abc',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(execute).toHaveBeenCalledWith({ date: '2026-10-10', limit: 2, cursor: 'abc' });
  });

  it('leaves limit and cursor undefined when they are absent', async () => {
    const execute = vi.fn<(query: SettlementQuery) => Promise<SettlementView>>(async () => view);
    const server = await start({ getSettlement: { execute } });
    await server.inject({ method: 'GET', url: '/settlements?date=2026-10-10' });
    const query = execute.mock.calls[0]?.[0];
    expect(query?.limit).toBeUndefined();
    expect(query?.cursor).toBeUndefined();
  });

  it('passes a non-numeric limit as NaN so the use case rejects it', async () => {
    const execute = vi.fn<(query: SettlementQuery) => Promise<SettlementView>>(async () => view);
    const server = await start({ getSettlement: { execute } });
    await server.inject({ method: 'GET', url: '/settlements?date=2026-10-10&limit=abc' });
    expect(Number.isNaN(execute.mock.calls[0]?.[0].limit)).toBe(true);
  });

  it('passes an empty date through so the use case rejects it', async () => {
    const execute = vi.fn<(query: SettlementQuery) => Promise<SettlementView>>(async () => view);
    const server = await start({ getSettlement: { execute } });
    await server.inject({ method: 'GET', url: '/settlements' });
    expect(execute.mock.calls[0]?.[0].date).toBe('');
  });

  it('maps an invalid query to 400 INVALID_QUERY', async () => {
    const server = await start({
      getSettlement: {
        execute: async () => {
          throw new InvalidSettlementQueryError('date must not be in the future');
        },
      },
    });
    const res = await server.inject({ method: 'GET', url: '/settlements?date=2999-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'INVALID_QUERY', message: 'date must not be in the future' },
    });
  });
});
