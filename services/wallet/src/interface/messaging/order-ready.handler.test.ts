import type { IncomingMessage } from '@billing/messaging';
import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import type { PayOrderInput, PayOrderOutcome } from '../../application/pay-order.js';
import type { Logger, TenantRegistry } from '../../application/ports.js';
import { TenantId } from '../../domain/tenant-id.js';
import { createOrderReadyHandler } from './order-ready.handler.js';

const acme = TenantId.parse('acme');
const registry: TenantRegistry = {
  resolve: (raw) => {
    if (raw === undefined || raw.trim() === '') throw new MissingTenantError('tenant is required');
    if (raw !== 'acme') throw new UnknownTenantError('unknown tenant');
    return acme;
  },
  all: () => [acme],
};

const event = {
  eventId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  occurredAtUtc: '2026-10-10T10:00:00Z',
  tenantId: 'acme',
  correlationId: 'corr-1',
  orderId: '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11',
  customerId: 'cust-1',
  amount: 150000,
  currency: 'VND',
};

const message = (body: unknown): IncomingMessage => ({
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  messageId: event.eventId,
  type: 'OrderReadyForPaymentV1',
  redelivered: false,
  retryCount: 0,
  headers: {},
});

function setup(outcome: PayOrderOutcome | Error) {
  const calls: PayOrderInput[] = [];
  const logs: Array<{ level: string; details: object }> = [];
  const log: Logger = {
    info: (details) => logs.push({ level: 'info', details }),
    warn: (details) => logs.push({ level: 'warn', details }),
    error: (details) => logs.push({ level: 'error', details }),
  };
  const handler = createOrderReadyHandler({
    registry,
    log,
    payOrder: {
      execute: async (input) => {
        calls.push(input);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  });
  return { handler, calls, logs };
}

describe('createOrderReadyHandler', () => {
  it('maps the event to a PayOrder call and acks', async () => {
    const { handler, calls } = setup({ kind: 'PAID', walletTransactionId: 'tx_1' });
    expect(await handler(message(event))).toEqual({ action: 'ack' });
    expect(calls).toEqual([
      {
        tenant: acme,
        eventId: event.eventId,
        correlationId: 'corr-1',
        orderId: event.orderId,
        customerId: 'cust-1',
        amount: 150000,
        currency: 'VND',
      },
    ]);
  });

  it.each<PayOrderOutcome>([
    { kind: 'PAID', walletTransactionId: 'tx_1' },
    { kind: 'REPLAYED', walletTransactionId: 'tx_1' },
    { kind: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' },
    { kind: 'DUPLICATE' },
  ])(
    'acks the business outcome %j (the result travels by outbox, not by retry)',
    async (outcome) => {
      const { handler, logs } = setup(outcome);
      expect(await handler(message(event))).toEqual({ action: 'ack' });
      expect(logs[0]).toMatchObject({
        level: 'info',
        details: { tenantId: 'acme', orderId: event.orderId, outcome: outcome.kind },
      });
    },
  );

  it.each([
    ['not JSON', '{oops'],
    ['schema-invalid', { ...event, amount: 0 }],
  ])('rejects a message that is %s without calling PayOrder', async (_name, body) => {
    const { handler, calls, logs } = setup({ kind: 'DUPLICATE' });
    const result = await handler(message(body));
    expect(result.action).toBe('reject');
    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it.each(['ghost', 'Acme', "acme'; drop table"])(
    'rejects tenant %j that the service does not host',
    async (tenantId) => {
      const { handler, calls } = setup({ kind: 'DUPLICATE' });
      expect((await handler(message({ ...event, tenantId }))).action).toBe('reject');
      expect(calls).toHaveLength(0);
    },
  );

  it('lets an infrastructure failure propagate so the consumer retries', async () => {
    const { handler } = setup(new Error('connection lost'));
    await expect(handler(message(event))).rejects.toThrow('connection lost');
  });

  it('never logs the raw message body', async () => {
    const { handler, logs } = setup({ kind: 'PAID', walletTransactionId: 'tx_1' });
    await handler(message(event));
    expect(JSON.stringify(logs)).not.toContain('cust-1');
  });
});
