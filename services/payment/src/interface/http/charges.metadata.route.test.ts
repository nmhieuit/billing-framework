import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateChargeInput, CreateChargeResult } from '../../application/create-charge.js';
import { InvalidChargeError } from '../../domain/errors.js';
import { buildApp, type AppDependencies } from './app.js';
import { stubDeps } from './stub-deps.js';

const created: CreateChargeResult = {
  status: 202,
  replayed: false,
  responseTimeout: false,
  body: {
    chargeId: 'ch_1',
    reference: 'tp_1',
    amount: 1000,
    currency: 'VND',
    status: 'PENDING',
    createdAt: '2026-10-09T10:00:00.000Z',
  },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<AppDependencies>): Promise<FastifyInstance> {
  app = await buildApp(stubDeps(overrides));
  return app;
}

const post = (server: FastifyInstance, payload: object) =>
  server.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    payload: JSON.stringify(payload),
  });

describe('POST /charges metadata', () => {
  it('forwards metadata untouched to the use case', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    await post(server, {
      amount: 1000,
      currency: 'VND',
      reference: 'tp_1',
      metadata: { tenantId: 'acme' },
    });
    expect(execute.mock.calls[0]?.[0].metadata).toEqual({ tenantId: 'acme' });
  });

  it('passes no metadata when the field is absent', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    await post(server, { amount: 1000, currency: 'VND', reference: 'tp_1' });
    expect(execute.mock.calls[0]?.[0].metadata).toBeUndefined();
  });

  it('maps invalid metadata to 400 INVALID_REQUEST', async () => {
    const server = await start({
      createCharge: {
        execute: async () => {
          throw new InvalidChargeError('metadata key "x-y" must match ^[a-zA-Z]');
        },
      },
    });
    const res = await post(server, {
      amount: 1000,
      currency: 'VND',
      reference: 'tp_1',
      metadata: { 'x-y': 'v' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });
});
