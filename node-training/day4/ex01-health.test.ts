import { expect, test } from 'vitest';
import { buildApp } from './ex01-health.js';

test('GET /health', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
