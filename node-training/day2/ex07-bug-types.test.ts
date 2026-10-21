import { expect, test } from 'vitest';
import { makeCustomer, totalBalance } from './ex07-bug-types.js';

test('khách mới có số dư 0', () => {
  expect(makeCustomer('c1', 'An')).toEqual({ id: 'c1', name: 'An', balance: 0 });
});

test('tổng số dư', () => {
  expect(
    totalBalance([
      { id: '1', name: 'A', balance: 10 },
      { id: '2', name: 'B', balance: 5 },
    ]),
  ).toBe(15);
});
