import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchersV3, MessageConsumerPact, asynchronousBodyHandler } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../application/errors.js';
import type { PayOrderInput } from '../application/pay-order.js';
import { TenantId } from '../domain/tenant-id.js';
import { createOrderReadyHandler } from '../interface/messaging/order-ready.handler.js';
import { silentLogger } from '../test-support.js';

const { like, uuid, integer, regex } = MatchersV3;
// RFC 3339 date-time: optional fractional seconds (.NET emits 7 digits) and Z or an offset.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const pactDir = fileURLToPath(new URL('../../../../pacts', import.meta.url));
const acme = TenantId.parse('acme');

describe('wallet as a consumer of the orders service', () => {
  it('reads OrderReadyForPaymentV1 with the production handler and records the contract', async () => {
    const calls: PayOrderInput[] = [];
    const handler = createOrderReadyHandler({
      registry: {
        resolve: (raw) => {
          if (raw === undefined || raw.trim() === '')
            throw new MissingTenantError('tenant is required');
          if (raw !== 'acme') throw new UnknownTenantError('unknown tenant');
          return acme;
        },
        all: () => [acme],
      },
      payOrder: {
        execute: async (input) => {
          calls.push(input);
          return { kind: 'PAID', walletTransactionId: 'tx_1' };
        },
      },
      log: silentLogger,
    });

    const pact = new MessageConsumerPact({
      consumer: 'wallet',
      provider: 'orders',
      dir: pactDir,
      logLevel: 'warn',
    });
    await pact
      .given('an order is complete and ready to be paid')
      .expectsToReceive('an OrderReadyForPaymentV1 event')
      .withContent({
        eventId: uuid('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02'),
        occurredAtUtc: regex(RFC3339, '2026-10-10T10:00:00Z'),
        tenantId: like('acme'),
        correlationId: like('corr-1'),
        orderId: uuid('0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11'),
        customerId: like('cust-1'),
        amount: integer(150000),
        currency: regex(/^(VND|USD)$/, 'VND'),
      })
      .withMetadata({ contentType: 'application/json' })
      .verify(
        asynchronousBodyHandler(async (body) => {
          const result = await handler({
            body: Buffer.from(JSON.stringify(body)),
            messageId: undefined,
            type: 'OrderReadyForPaymentV1',
            redelivered: false,
            retryCount: 0,
            headers: {},
          });
          expect(result).toEqual({ action: 'ack' });
        }),
      );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tenant: acme,
      customerId: 'cust-1',
      amount: 150000,
      currency: 'VND',
    });
  });

  it('wrote a pact file that names wallet as the consumer and orders as the provider', () => {
    const file = JSON.parse(readFileSync(path.join(pactDir, 'wallet-orders.json'), 'utf8')) as {
      consumer: { name: string };
      provider: { name: string };
    };
    expect(file.consumer.name).toBe('wallet');
    expect(file.provider.name).toBe('orders');
    expect(JSON.stringify(file)).toContain('an OrderReadyForPaymentV1 event');
  });
});
