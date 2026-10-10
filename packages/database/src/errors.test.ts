import { describe, expect, it } from 'vitest';
import { isMissingObject, isUniqueViolation } from './errors.js';

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

describe('isMissingObject', () => {
  it('recognises SQL Server error 208 (invalid object name)', () => {
    expect(isMissingObject({ number: 208 })).toBe(true);
  });

  it.each([null, undefined, 'x', new Error('boom'), { number: 2627 }, { number: '208' }])(
    'rejects %j',
    (value) => {
      expect(isMissingObject(value)).toBe(false);
    },
  );
});
