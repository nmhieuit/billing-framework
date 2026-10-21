import { expect, test } from 'vitest';
import { buildApp } from './ex09-bug-late-route.js';

test('có cả hai route', async () => {
  const app = await buildApp();
  expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/version' })).json()).toEqual({ version: '1.0.0' });
});
