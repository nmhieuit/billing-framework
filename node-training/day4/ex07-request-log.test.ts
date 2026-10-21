import { expect, test } from 'vitest';
import { buildApp } from './ex07-request-log.js';

test('mỗi response ghi một dòng log', async () => {
  const lines: string[] = [];
  const app = buildApp((line) => lines.push(line));
  await app.inject({ method: 'GET', url: '/health' });
  await app.inject({ method: 'POST', url: '/echo', payload: { a: 1 } });
  await app.inject({ method: 'GET', url: '/khong-co' });
  expect(lines).toEqual(['GET /health 200', 'POST /echo 200', 'GET /khong-co 404']);
});
