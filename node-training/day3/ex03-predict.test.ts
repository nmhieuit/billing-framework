import { expect, test } from 'vitest';
import { answer } from './ex03-predict.js';
import { scenario } from './ex03-scenario.js';

test('đoán đúng thứ tự', async () => {
  // Chạy kịch bản thật rồi so với dự đoán của bạn
  expect(answer).toEqual(await scenario());
});
