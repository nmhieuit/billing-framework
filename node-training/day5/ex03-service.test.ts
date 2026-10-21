import { expect, test } from 'vitest';
import { InsufficientFundsError, WithdrawService } from './ex03-service.js';
import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import { InMemoryWalletRepository } from './support/wallet-repository.js';

function setup() {
  const repo = new InMemoryWalletRepository();
  repo.save({ id: 'w1', owner: 'An', balance: 100 });
  return { repo, service: new WithdrawService(repo) };
}

test('rút tiền thành công và được lưu lại', () => {
  const { repo, service } = setup();
  expect(service.withdraw('w1', 30).balance).toBe(70);
  expect(repo.findById('w1')?.balance).toBe(70);
});

test('rút đúng bằng số dư', () => {
  expect(setup().service.withdraw('w1', 100).balance).toBe(0);
});

test('amount không hợp lệ', () => {
  const { service } = setup();
  expect(() => service.withdraw('w1', 0)).toThrow(InvalidAmountError);
  expect(() => service.withdraw('w1', 1.5)).toThrow(InvalidAmountError);
});

test('ví không tồn tại', () => {
  expect(() => setup().service.withdraw('zz', 5)).toThrow(WalletNotFoundError);
});

test('không đủ tiền: lỗi và số dư không đổi', () => {
  const { repo, service } = setup();
  expect(() => service.withdraw('w1', 101)).toThrow(InsufficientFundsError);
  expect(() => service.withdraw('w1', 101)).toThrow('insufficient funds');
  expect(repo.findById('w1')?.balance).toBe(100);
});
