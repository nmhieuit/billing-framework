import { expect, test } from 'vitest';
import { buildApp } from './ex02-hello.js';

test('chào theo tên trên URL', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/hello/An' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ message: 'Xin chào, An!' });
});

test('tên khác', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/hello/Bình' });
  expect(res.json()).toEqual({ message: 'Xin chào, Bình!' });
});
