import { recordingTelemetry } from '@billing/observability';
import { describe, expect, it } from 'vitest';
import type { TenantState, WalletState } from '../application/state.js';
import { OtelWalletMetrics } from './otel-metrics.js';

const key = (attributes: Record<string, string>): string => JSON.stringify(attributes);

const tenantState = (tenant: string, overrides: Partial<TenantState> = {}): TenantState => ({
  tenant,
  outboxPending: 2,
  outboxOldestAgeSeconds: 30,
  topupsRequestedBacklog: 1,
  topupsOldestRequestedAgeSeconds: 12,
  openItemsByKind: { MISSING_AT_WALLET: 4 },
  oldestOpenItemAgeSeconds: 600,
  lastReconciliationSuccessAgeSeconds: 3600,
  ...overrides,
});

function setup() {
  const { telemetry, collect } = recordingTelemetry();
  return { metrics: new OtelWalletMetrics(telemetry), collect, telemetry };
}

describe('OtelWalletMetrics — counters', () => {
  it('counts order payments per tenant and outcome', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.orderPayment('acme', 'paid');
    metrics.orderPayment('acme', 'paid');
    metrics.orderPayment('acme', 'failed:INSUFFICIENT_FUNDS');
    const points = (await collect()).get('billing.order_payments');
    expect(points?.get(key({ tenant: 'acme', outcome: 'paid' }))).toBe(2);
    expect(points?.get(key({ tenant: 'acme', outcome: 'failed:INSUFFICIENT_FUNDS' }))).toBe(1);
    await telemetry.shutdown();
  });

  it('counts consumer messages, top-ups and reconciliation runs with their labels', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.consumerMessage('retried');
    metrics.topup('acme', 'submit', 'submitted');
    metrics.reconciliationRun('acme', 'FAILED');
    const all = await collect();
    expect(all.get('billing.consumer.messages')?.get(key({ result: 'retried' }))).toBe(1);
    expect(
      all
        .get('billing.topups')
        ?.get(key({ tenant: 'acme', stage: 'submit', outcome: 'submitted' })),
    ).toBe(1);
    expect(
      all.get('billing.reconciliation.runs')?.get(key({ tenant: 'acme', status: 'FAILED' })),
    ).toBe(1);
    await telemetry.shutdown();
  });

  it('prime creates the series at zero so the first increment is a visible increase', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.prime(['acme']);
    const all = await collect();
    expect(all.get('billing.order_payments')?.get(key({ tenant: 'acme', outcome: 'paid' }))).toBe(
      0,
    );
    const runs = all.get('billing.reconciliation.runs');
    expect(runs?.get(key({ tenant: 'acme', status: 'COMPLETED' }))).toBe(0);
    expect(runs?.get(key({ tenant: 'acme', status: 'FAILED' }))).toBe(0);
    const messages = all.get('billing.consumer.messages');
    for (const result of ['processed', 'retried', 'dead_lettered', 'rejected']) {
      expect(messages?.get(key({ result }))).toBe(0);
    }

    metrics.reconciliationRun('acme', 'FAILED');
    expect(
      (await collect())
        .get('billing.reconciliation.runs')
        ?.get(key({ tenant: 'acme', status: 'FAILED' })),
    ).toBe(1);
    await telemetry.shutdown();
  });
});

describe('OtelWalletMetrics — gauges', () => {
  it('publishes per-tenant gauges, per-kind open items and the DLQ depth', async () => {
    const { metrics, collect, telemetry } = setup();
    const state: WalletState = {
      dlqDepth: 3,
      tenants: [
        tenantState('acme'),
        tenantState('beta', {
          outboxPending: 0,
          outboxOldestAgeSeconds: 0,
          openItemsByKind: { UNKNOWN_CHARGE: 1, AMOUNT_MISMATCH: 2 },
          lastReconciliationSuccessAgeSeconds: null,
        }),
      ],
    };
    metrics.publishState(state);
    const all = await collect();
    const acme = key({ tenant: 'acme' });
    const beta = key({ tenant: 'beta' });

    expect(all.get('billing.dlq.depth')?.get(key({ queue: 'wallet.order-payments.dlq' }))).toBe(3);
    expect(all.get('billing.outbox.pending')?.get(acme)).toBe(2);
    expect(all.get('billing.outbox.pending')?.get(beta)).toBe(0);
    expect(all.get('billing.outbox.oldest_age_seconds')?.get(acme)).toBe(30);
    expect(all.get('billing.topups.requested_backlog')?.get(acme)).toBe(1);
    expect(all.get('billing.topups.oldest_requested_age_seconds')?.get(acme)).toBe(12);
    expect(all.get('billing.reconciliation.oldest_open_item_age_seconds')?.get(acme)).toBe(600);
    expect(all.get('billing.reconciliation.last_success_age_seconds')?.get(acme)).toBe(3600);
    // Chưa có lượt đối soát nào hoàn tất: bỏ hẳn mẫu thay vì báo 0.
    expect(all.get('billing.reconciliation.last_success_age_seconds')?.has(beta)).toBe(false);

    const openItems = all.get('billing.reconciliation.open_items');
    expect(openItems?.get(key({ tenant: 'acme', kind: 'MISSING_AT_WALLET' }))).toBe(4);
    expect(openItems?.get(key({ tenant: 'beta', kind: 'UNKNOWN_CHARGE' }))).toBe(1);
    expect(openItems?.get(key({ tenant: 'beta', kind: 'AMOUNT_MISMATCH' }))).toBe(2);
    await telemetry.shutdown();
  });

  it('omits the DLQ sample when the depth is unknown', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.publishState({ dlqDepth: 5, tenants: [] });
    expect((await collect()).get('billing.dlq.depth')?.size).toBe(1);
    metrics.publishState({ dlqDepth: null, tenants: [] });
    expect((await collect()).get('billing.dlq.depth')?.size ?? 0).toBe(0);
    await telemetry.shutdown();
  });

  it('drops the samples of a tenant that is missing from the next publish', async () => {
    const { metrics, collect, telemetry } = setup();
    metrics.publishState({ dlqDepth: 0, tenants: [tenantState('acme'), tenantState('beta')] });
    metrics.publishState({ dlqDepth: 0, tenants: [tenantState('acme')] });
    const all = await collect();
    const pending = all.get('billing.outbox.pending');
    expect(pending?.has(key({ tenant: 'acme' }))).toBe(true);
    expect(pending?.has(key({ tenant: 'beta' }))).toBe(false);
    expect(
      all
        .get('billing.reconciliation.open_items')
        ?.has(key({ tenant: 'beta', kind: 'MISSING_AT_WALLET' })),
    ).toBe(false);
    await telemetry.shutdown();
  });
});

describe('OtelWalletMetrics — retention', () => {
  const NOW = new Date('2026-10-12T01:00:00Z');
  const setupRetention = () => {
    const { telemetry, collect } = recordingTelemetry();
    return { metrics: new OtelWalletMetrics(telemetry, () => NOW), collect, telemetry };
  };

  it('counts rows per tenant, table and mode and skips zero counts', async () => {
    const { metrics, collect, telemetry } = setupRetention();
    metrics.retentionRun({
      dryRun: false,
      errors: 0,
      rows: [
        { tenant: 'acme', table: 'outbox_sent', count: 5 },
        { tenant: 'acme', table: 'idempotency_keys', count: 0 },
      ],
    });
    metrics.retentionRun({
      dryRun: true,
      errors: 0,
      rows: [{ tenant: 'acme', table: 'outbox_sent', count: 9 }],
    });
    const points = (await collect()).get('billing.retention.rows');
    expect(points?.get(key({ tenant: 'acme', table: 'outbox_sent', mode: 'deleted' }))).toBe(5);
    expect(points?.get(key({ tenant: 'acme', table: 'outbox_sent', mode: 'would_delete' }))).toBe(
      9,
    );
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
