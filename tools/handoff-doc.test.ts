import { readFileSync } from 'node:fs';
import { validateEvent, type EventName } from '@billing/contracts';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(
  new URL('../docs/integration/orders-handoff.vi.md', import.meta.url),
  'utf8',
);
const examples = [...doc.matchAll(/<!-- example: (\w+) -->\s*```json\n([\s\S]*?)\n```/g)].map(
  (match) => ({
    name: match[1] as EventName,
    json: JSON.parse(match[2] ?? 'null') as unknown,
  }),
);

describe('docs/integration/orders-handoff.vi.md', () => {
  it('carries an example for each of the three events', () => {
    expect(examples.map((e) => e.name).sort()).toEqual([
      'OrderPaidV1',
      'OrderPaymentFailedV1',
      'OrderReadyForPaymentV1',
    ]);
  });

  it.each(examples)('has a $name example that satisfies the published schema', ({ name, json }) => {
    const result = validateEvent(name, json);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('names the routing keys and the vhost the handoff relies on', () => {
    for (const text of [
      'order-ready-for-payment.v1',
      'order-paid.v1',
      'order-payment-failed.v1',
      'vhost `billing`',
      'ecommerce_orders',
    ]) {
      expect(doc).toContain(text);
    }
  });
});
