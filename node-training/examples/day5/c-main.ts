import { WalletRepository } from './b-repository.js';
import { WalletService } from './c-service.js';

const repo = new WalletRepository();
repo.save({ id: 'w1', owner: 'An', balance: 100 });
const service = new WalletService(repo);

console.log(service.deposit('w1', 50));
console.log(service.deposit('w1', 25));
try {
  service.deposit('zz', 1);
} catch (error) {
  console.log((error as Error).message);
}
