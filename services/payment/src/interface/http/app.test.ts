import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getCorrelationId } from '@billing/observability';
import { buildApp } from './app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('reports ok with the service name', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'payment' });
  });

  it('generates a correlation id when the caller sends none', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-correlation-id']).toMatch(UUID);
  });

  it('echoes a valid incoming correlation id', async () => {
    const id = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': id },
    });
    expect(res.headers['x-correlation-id']).toBe(id);
  });

  it('makes the correlation id visible to handlers', async () => {
    let seen: string | undefined;
    app.get('/probe', async () => {
      seen = getCorrelationId();
      return {};
    });
    const id = '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01';
    await app.inject({ method: 'GET', url: '/probe', headers: { 'x-correlation-id': id } });
    expect(seen).toBe(id);
  });
});
