import { describe, expect, it } from 'vitest';
import { CustomerId } from './customer-id.js';
import { InvalidCustomerError } from './errors.js';

describe('CustomerId.parse', () => {
  it.each(['c1', 'C_1-x', '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01', 'a'.repeat(64)])(
    'accepts %s',
    (raw) => {
      expect(CustomerId.parse(raw).value).toBe(raw);
    },
  );

  it.each(['', ' c1', 'c 1', 'c:1', 'c/1', 'a'.repeat(65), 'c1\n'])('rejects %j', (raw) => {
    expect(() => CustomerId.parse(raw)).toThrow(InvalidCustomerError);
  });
});
