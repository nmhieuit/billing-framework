import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.js';

describe('isUniqueViolation', () => {
  it.each([2627, 2601])('recognises SQL Server error number %d', (number) => {
    expect(isUniqueViolation({ number })).toBe(true);
  });

  it.each([null, undefined, 'x', new Error('boom'), { number: 547 }, { number: '2627' }])(
    'rejects %j',
    (value) => {
      expect(isUniqueViolation(value)).toBe(false);
    },
  );
});
