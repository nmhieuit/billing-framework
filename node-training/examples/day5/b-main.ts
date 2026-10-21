import { WalletRepository } from './b-repository.js';

const repo = new WalletRepository();
repo.save({ id: 'w1', owner: 'An', balance: 100 });

const copy = repo.findById('w1');
if (copy) {
  copy.balance = 999;
}
console.log('trong kho:', repo.findById('w1')?.balance);
console.log('bản sao  :', copy?.balance);
