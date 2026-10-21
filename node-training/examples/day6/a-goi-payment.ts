import { startFakePayment } from '../../day6/support/fake-payment.js';

const payment = await startFakePayment(['ok']);

const response = await fetch(`${payment.url}/charges`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ amount: 100 }),
});
console.log(response.status);
console.log(await response.json());

await payment.close();
