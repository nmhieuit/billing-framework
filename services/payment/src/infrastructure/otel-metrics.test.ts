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

  it('stops reporting both gauges after publishState(null)', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.publishState({ webhookPending: 4, webhookOldestAgeSeconds: 90 });
    expect((await collect()).get('billing.payment.webhook_backlog')?.size).toBe(1);

    metrics.publishState(null);
    const all = await collect();
    expect(all.get('billing.payment.webhook_backlog')?.size ?? 0).toBe(0);
    expect(all.get('billing.payment.webhook_oldest_age_seconds')?.size ?? 0).toBe(0);
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

describe('OtelPaymentMetrics — retention', () => {
  const NOW = new Date('2026-10-12T01:00:00Z');
  const setupRetention = () => {
    const { telemetry, collect } = recordingTelemetry();
    return { metrics: new OtelPaymentMetrics(telemetry, () => NOW), collect, telemetry };
  };

  it('counts rows per table and mode and skips zero counts', async () => {
    const { metrics, collect, telemetry } = setupRetention();
    metrics.retentionRun({
      dryRun: false,
      errors: 0,
      rows: [
        { table: 'webhook_events', count: 5 },
        { table: 'idempotency_keys', count: 0 },
      ],
    });
    metrics.retentionRun({
      dryRun: true,
      errors: 0,
      rows: [{ table: 'webhook_events', count: 9 }],
    });
    const points = (await collect()).get('billing.retention.rows');
    expect(points?.get(key({ table: 'webhook_events', mode: 'deleted' }))).toBe(5);
    expect(points?.get(key({ table: 'webhook_events', mode: 'would_delete' }))).toBe(9);
    expect(points?.size).toBe(2);
    await telemetry.shutdown();
  });

  it('sets the success timestamp only for an error-free run', async () => {
    const { metrics, collect, telemetry } = setupRetention();
    const gauge = 'billing.retention.last_success_timestamp_seconds';
    metrics.retentionRun({ dryRun: false, errors: 1, rows: [] });
    expect((await collect()).get(gauge)?.size ?? 0).toBe(0);
    metrics.retentionRun({ dryRun: false, errors: 0, rows: [] });
    expect((await collect()).get(gauge)?.get(key({}))).toBe(Math.floor(NOW.getTime() / 1000));
    metrics.retentionRun({ dryRun: false, errors: 2, rows: [] });
    expect((await collect()).get(gauge)?.get(key({}))).toBe(Math.floor(NOW.getTime() / 1000));
    await telemetry.shutdown();
  });
});
