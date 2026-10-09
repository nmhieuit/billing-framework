import { describe, expect, it } from 'vitest';
import { toSafeInteger } from './numbers.js';

describe('toSafeInteger', () => {
  it.each([
    ['5', 5],
    ['-12', -12],
    [7, 7],
    [5n, 5],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('converts %s to %d', (input, expected) => {
    expect(toSafeInteger(input)).toBe(expected);
  });

  it.each(['9007199254740993', 1.5, 'abc', '1e3', '', 2 ** 60, 9007199254740993n])(
    'rejects %s',
    (input) => {
      expect(() => toSafeInteger(input)).toThrow(RangeError);
    },
  );
});
