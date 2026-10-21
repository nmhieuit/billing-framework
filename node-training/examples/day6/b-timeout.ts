import { startFakePayment } from '../../day6/support/fake-payment.js';

const payment = await startFakePayment(['slow'], 2000);

const start = Date.now();
try {
  await fetch(`${payment.url}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 100 }),
    signal: AbortSignal.timeout(300),
  });
} catch (error) {
  console.log('lỗi:', (error as Error).name, `sau ${Date.now() - start}ms`);
}

await payment.close();
