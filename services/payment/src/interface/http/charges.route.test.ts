import { InvalidMoneyError } from '@billing/money';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateChargeInput, CreateChargeResult } from '../../application/create-charge.js';
import { ChargeNotFoundError, IdempotencyConflictError } from '../../application/errors.js';
import { InvalidChargeError } from '../../domain/errors.js';
import { InvalidScenarioError } from '../../domain/scenario.js';
import { buildApp, type AppDependencies } from './app.js';
import { stubDeps } from './stub-deps.js';

const created: CreateChargeResult = {
  status: 202,
  replayed: false,
  responseTimeout: false,
  body: {
    chargeId: 'ch_1',
    reference: 'topup-1',
    amount: 150000,
    currency: 'VND',
    status: 'PENDING',
    createdAt: '2026-10-09T10:00:00.000Z',
  },
};
const validBody = { amount: 150000, currency: 'VND', reference: 'topup-1' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  app = await buildApp(stubDeps(overrides));
  return app;
}

function post(
  server: FastifyInstance,
  options: { headers?: Record<string, string>; payload?: string } = {},
) {
  return server.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1', ...options.headers },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

const failWith = (error: Error): Partial<AppDependencies> => ({
  createCharge: {
    execute: async () => {
      throw error;
    },
  },
});

describe('POST /charges', () => {
  it('forwards a valid request to the use case and answers with its result', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    const res = await post(server, {
      headers: { 'x-simulate': 'delay=3' },
      payload: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(created.body);
    expect(res.headers['x-correlation-id']).toBeTruthy();
    expect(execute).toHaveBeenCalledWith({
      idempotencyKey: 'k1',
      amount: 150000,
      currency: 'VND',
      reference: 'topup-1',
      simulate: 'delay=3',
    });
  });

  it('passes no simulation when X-Simulate is absent', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    await post(server, { payload: JSON.stringify(validBody) });
    expect(execute.mock.calls[0]?.[0].simulate).toBeUndefined();
  });

  it('replays the stored status and body', async () => {
    const server = await start({
      createCharge: { execute: async () => ({ ...created, replayed: true }) },
    });
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(created.body);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('rejects an %s Idempotency-Key', async (_name, key) => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    const res = await server.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      payload: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'MISSING_IDEMPOTENCY_KEY', message: expect.any(String) },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts a 255-character Idempotency-Key and rejects 256', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    const ok = await post(server, {
      headers: { 'idempotency-key': 'k'.repeat(255) },
      payload: JSON.stringify(validBody),
    });
    expect(ok.statusCode).toBe(202);
    const tooLong = await post(server, {
      headers: { 'idempotency-key': 'k'.repeat(256) },
      payload: JSON.stringify(validBody),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it.each([
    ['leading whitespace', ' key-1'],
    ['trailing whitespace', 'key-1 '],
    ['surrounding whitespace', '\tkey-1 '],
  ])(
    'rejects an Idempotency-Key with %s as INVALID_IDEMPOTENCY_KEY without calling the use case',
    async (_name, headerValue) => {
      const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
        async () => created,
      );
      const server = await start({ createCharge: { execute } });
      const res = await post(server, {
        headers: { 'idempotency-key': headerValue },
        payload: JSON.stringify(validBody),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['malformed JSON', '{bad'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string amount', JSON.stringify({ ...validBody, amount: '150000' })],
    ['a missing currency', JSON.stringify({ amount: 1, reference: 'x' })],
    ['a missing reference', JSON.stringify({ amount: 1, currency: 'VND' })],
    ['a non-string reference', JSON.stringify({ ...validBody, reference: 7 })],
  ])('rejects %s with INVALID_REQUEST without calling the use case', async (_name, payload) => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(
      async () => created,
    );
    const server = await start({ createCharge: { execute } });
    const res = await post(server, { payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const server = await start();
    const res = await post(server);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it.each([
    ['an invalid scenario', new InvalidScenarioError('unknown key "x"'), 400, 'INVALID_SIMULATE'],
    [
      'an invalid amount',
      new InvalidMoneyError('amount must be a safe integer'),
      400,
      'INVALID_REQUEST',
    ],
    [
      'an invalid charge',
      new InvalidChargeError('reference must be 1..200 characters'),
      400,
      'INVALID_REQUEST',
    ],
    ['a reused key', new IdempotencyConflictError('key reused'), 422, 'IDEMPOTENCY_KEY_REUSED'],
  ])('maps %s to its HTTP status and error code', async (_name, error, status, code) => {
    const server = await start(failWith(error));
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: error.message } });
  });

  it('hides the cause of an unexpected error but logs it', async () => {
    const log = { error: vi.fn() };
    const server = await start({ ...failWith(new Error('db exploded: secret')), log });
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal server error' } });
    expect(res.body).not.toContain('secret');
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('holds the response for response=timeout on the first call only', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const timedOut = { ...created, responseTimeout: true };
    const server = await start({
      createCharge: { execute: async () => timedOut },
      responseTimeoutMs: 1234,
      sleep,
    });
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(202);
    expect(sleep).toHaveBeenCalledWith(1234);

    sleep.mockClear();
    const replayServer = await buildApp(
      stubDeps({ createCharge: { execute: async () => created }, sleep }),
    );
    await post(replayServer, { payload: JSON.stringify(validBody) });
    expect(sleep).not.toHaveBeenCalled();
    await replayServer.close();
  });
});

describe('GET /charges/:id', () => {
  it('returns the charge the use case found', async () => {
    const view = {
      ...created.body,
      status: 'SUCCEEDED' as const,
      completedAt: '2026-10-09T10:00:01.000Z',
    };
    const execute = vi.fn<(id: string) => Promise<typeof view>>(async () => view);
    const server = await start({ getCharge: { execute } });
    const res = await server.inject({ method: 'GET', url: '/charges/ch_1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(execute).toHaveBeenCalledWith('ch_1');
  });

  it('answers 404 CHARGE_NOT_FOUND', async () => {
    const server = await start({
      getCharge: {
        execute: async () => {
          throw new ChargeNotFoundError('charge ch_x not found');
        },
      },
    });
    const res = await server.inject({ method: 'GET', url: '/charges/ch_x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CHARGE_NOT_FOUND');
  });
});

describe('unknown routes', () => {
  it('answer 404 NOT_FOUND in the same error format', async () => {
    const server = await start();
    const res = await server.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
