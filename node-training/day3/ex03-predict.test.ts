import { expect, test } from 'vitest';
import { answer } from './ex03-predict.js';
import { scenario } from './ex03-scenario.js';

test('đoán đúng thứ tự', async () => {
  expect(answer).toEqual(await scenario());
});
