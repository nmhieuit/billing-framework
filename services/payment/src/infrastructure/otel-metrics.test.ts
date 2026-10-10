import { recordingTelemetry } from '@billing/observability';
import { describe, expect, it } from 'vitest';
import { OtelPaymentMetrics } from './otel-metrics.js';

const key = (attributes: Record<string, string>): string => JSON.stringify(attributes);

function setup() {
  const { telemetry, collect } = recordingTelemetry();
  return { metrics: new OtelPaymentMetrics(telemetry), collect, telemetry };
}

describe('OtelPaymentMetrics', () => {
  it('counts completed charges by status', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.charge('SUCCEEDED');
    metrics.charge('SUCCEEDED');
    metrics.charge('FAILED');
    const points = (await collect()).get('billing.payment.charges');
    expect(points?.get(key({ status: 'SUCCEEDED' }))).toBe(2);
    expect(points?.get(key({ status: 'FAILED' }))).toBe(1);
    await telemetry.shutdown();
  });

  it('counts webhook deliveries by result', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.webhookDelivery('failed');
    metrics.webhookDelivery('delivered');
    const points = (await collect()).get('billing.payment.webhook_deliveries');
    expect(points?.get(key({ result: 'failed' }))).toBe(1);
    expect(points?.get(key({ result: 'delivered' }))).toBe(1);
    await telemetry.shutdown();
  });

  it('publishes both backlog gauges without attributes and replaces them on the next call', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.publishState({ webhookPending: 4, webhookOldestAgeSeconds: 90 });
    let all = await collect();
    expect(all.get('billing.payment.webhook_backlog')?.get(key({}))).toBe(4);
    expect(all.get('billing.payment.webhook_oldest_age_seconds')?.get(key({}))).toBe(90);

    metrics.publishState({ webhookPending: 0, webhookOldestAgeSeconds: 0 });
    all = await collect();
    expect(all.get('billing.payment.webhook_backlog')?.get(key({}))).toBe(0);
    expect(all.get('billing.payment.webhook_oldest_age_seconds')?.get(key({}))).toBe(0);
    expect(all.get('billing.payment.webhook_backlog')?.size).toBe(1);
    await telemetry.shutdown();
  });
});
