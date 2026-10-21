import { expect, test } from 'vitest';
import { WalletRepository } from './ex02-repository.js';

test('lưu rồi đọc', () => {
  const repo = new WalletRepository();
  repo.save({ id: 'w1', owner: 'An', balance: 10 });
  expect(repo.findById('w1')).toEqual({ id: 'w1', owner: 'An', balance: 10 });
  expect(repo.findById('w2')).toBeUndefined();
});

test('save cùng id thì ghi đè, count không tăng', () => {
  const repo = new WalletRepository();
  repo.save({ id: 'w1', owner: 'An', balance: 10 });
  repo.save({ id: 'w1', owner: 'An', balance: 20 });
  expect(repo.count()).toBe(1);
  expect(repo.findById('w1')?.balance).toBe(20);
});

test('sửa bản sao đọc ra không làm đổi dữ liệu trong kho', () => {
  const repo = new WalletRepository();
  repo.save({ id: 'w1', owner: 'An', balance: 10 });
  const copy = repo.findById('w1');
  if (copy) copy.balance = 999;
  expect(repo.findById('w1')?.balance).toBe(10);
});

test('sửa đối tượng đã đưa vào save không làm đổi dữ liệu trong kho', () => {
  const repo = new WalletRepository();
  const wallet = { id: 'w1', owner: 'An', balance: 10 };
  repo.save(wallet);
  wallet.balance = 999;
  expect(repo.findById('w1')?.balance).toBe(10);
});
