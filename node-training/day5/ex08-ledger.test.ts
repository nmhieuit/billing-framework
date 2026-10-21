import { expect, test } from 'vitest';
import { Ledger } from './ex08-ledger.js';

const topup = [
  { account: 'wallet:an', amount: 100 },
  { account: 'bank', amount: -100 },
];

test('ghi nạp tiền cập nhật số dư hai bên', () => {
  const ledger = new Ledger();
  ledger.post('topup:t1', topup);
  expect(ledger.balanceOf('wallet:an')).toBe(100);
  expect(ledger.balanceOf('bank')).toBe(-100);
  expect(ledger.balanceOf('khong-co')).toBe(0);
});

test('tổng khác 0 bị từ chối và không lưu gì', () => {
  const ledger = new Ledger();
  expect(() => ledger.post('x', [{ account: 'a', amount: 10 }, { account: 'b', amount: -5 }])).toThrow('entries must balance');
  expect(ledger.balanceOf('a')).toBe(0);
});

test('reference trùng bị từ chối', () => {
  const ledger = new Ledger();
  ledger.post('topup:t1', topup);
  expect(() => ledger.post('topup:t1', topup)).toThrow('duplicate reference: topup:t1');
  expect(ledger.balanceOf('wallet:an')).toBe(100);
});

test('cần ít nhất hai dòng', () => {
  expect(() => new Ledger().post('x', [{ account: 'a', amount: 0 }])).toThrow('at least two entries required');
});
