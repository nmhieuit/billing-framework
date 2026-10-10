import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEvent } from '@billing/contracts';
import { MessageProviderPact } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayOrder } from '../application/pay-order.js';
import { createHarness, fundWallet, silentLogger, type Harness } from '../test-support.js';

const fixturePath = fileURLToPath(
  new URL('../../pact-fixtures/orders-wallet.json', import.meta.url),
);

let h: Harness;
let pay: PayOrder;

beforeAll(async () => {
  h = await createHarness();
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
});
afterAll(async () => {
  await h.close();
});

/** Chạy PayOrder thật rồi lấy payload mà relay sẽ publish: đúng thứ ecommerce sẽ nhận. */
async function producedBy(customer: string, fund: number, amount: number): Promise<unknown> {
  await fundWallet(h, { customer, amount: fund });
  const orderId = randomUUID();
  await pay.execute({
    tenant: h.acme,
    eventId: randomUUID(),
    correlationId: 'corr-pact',
    orderId,
    customerId: customer,
    amount,
    currency: 'VND',
  });
  const row = await h.db
    .withSchema('t_acme')
    .selectFrom('outbox')
    .select('payload')
    .where('payload', 'like', `%${orderId}%`)
    .executeTakeFirstOrThrow();
  return JSON.parse(row.payload) as unknown;
}

function pactSource(): Record<string, unknown> {
  const url = process.env.PACT_BROKER_BASE_URL?.trim();
  if (!url) return { pactUrls: [fixturePath] };
  const username = process.env.PACT_BROKER_USERNAME;
  const password = process.env.PACT_BROKER_PASSWORD;
  return {
    pactBrokerUrl: url,
    ...(username && password ? { pactBrokerUsername: username, pactBrokerPassword: password } : {}),
    consumerVersionSelectors: [{ mainBranch: true }],
    publishVerificationResult: process.env.PACT_PUBLISH_VERIFICATION === 'true',
    providerVersion: process.env.PACT_PROVIDER_VERSION ?? 'local',
    providerVersionBranch: process.env.PACT_PROVIDER_BRANCH ?? 'local',
  };
}

describe('wallet as a provider for the orders service', () => {
  it('produces the OrderPaid and OrderPaymentFailed events the orders contract expects', async () => {
    const verifier = new MessageProviderPact({
      provider: 'wallet',
      logLevel: 'warn',
      messageProviders: {
        'an OrderPaidV1 event': async () => {
          const body = await producedBy('pact-paid', 200000, 150000);
          expect(validateEvent('OrderPaidV1', body).ok).toBe(true);
          return body;
        },
        'an OrderPaymentFailedV1 event': async () => {
          const body = await producedBy('pact-broke', 1000, 150000);
          expect(validateEvent('OrderPaymentFailedV1', body).ok).toBe(true);
          return body;
        },
      },
      ...pactSource(),
    });
    await verifier.verify();
  }, 120_000);

  it('keeps the checked-in sample pact itself valid against the published schemas', () => {
    const pact = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      messages: Array<{ description: string; contents: unknown }>;
    };
    const byDescription = new Map(pact.messages.map((m) => [m.description, m.contents]));
    expect(validateEvent('OrderPaidV1', byDescription.get('an OrderPaidV1 event')).ok).toBe(true);
    expect(
      validateEvent('OrderPaymentFailedV1', byDescription.get('an OrderPaymentFailedV1 event')).ok,
    ).toBe(true);
  });
});
