import { expect, test } from 'vitest';
import { answer } from './ex01-predict.js';
import { scenario } from './ex01-scenario.js';

test('đoán đúng thứ tự', async () => {
  expect(answer).toEqual(await scenario());
});
