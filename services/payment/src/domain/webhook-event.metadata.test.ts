import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Charge } from './charge.js';
import { DEFAULT_SCENARIO } from './scenario.js';
import { WebhookEvent } from './webhook-event.js';

const now = new Date('2026-10-09T10:00:00.000Z');
const completed = (metadata?: Record<string, string>) =>
  Charge.create({
    id: 'ch_1',
    reference: 'tp_1',
    amount: Money.of(1000, 'VND'),
    scenario: DEFAULT_SCENARIO,
    now,
    ...(metadata ? { metadata } : {}),
  }).complete(now);

describe('WebhookEvent payload metadata', () => {
  it('includes data.metadata when the charge has metadata', () => {
    const event = WebhookEvent.forCharge(completed({ tenantId: 'acme' }), 'evt_1', now);
    expect(JSON.parse(event.toProps().payload).data.metadata).toEqual({ tenantId: 'acme' });
  });

  it('omits data.metadata entirely when the charge has none', () => {
    const event = WebhookEvent.forCharge(completed(), 'evt_1', now);
    expect(JSON.parse(event.toProps().payload).data).not.toHaveProperty('metadata');
  });
});
