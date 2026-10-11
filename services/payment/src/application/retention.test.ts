import { FakeClock } from '@billing/testing';
import { describe, expect, it } from 'vitest';
import { RecordingMetrics } from '../test-support-metrics.js';
import type { Logger, Repositories, UnitOfWork } from './ports.js';
import {
  PAYMENT_RETENTION_POLICIES,
  RunRetention,
  type PaymentRetentionPolicy,
  type PaymentRetentionSettings,
  type RetentionRepository,
} from './retention.js';

interface PurgeCall {
  policy: PaymentRetentionPolicy;
  cutoff: Date;
  batchSize: number;
  dryRun: boolean;
}

const settings = (overrides: Partial<PaymentRetentionSettings> = {}): PaymentRetentionSettings => ({
  dryRun: false,
  batchSize: 1000,
  maxSecondsPerRun: 600,
  days: { webhook: 30, idempotencyKeys: 90 },
  ...overrides,
});

function setup(
  respond: (call: PurgeCall, nth: number) => number | Promise<number> = () => 0,
  overrides: Partial<PaymentRetentionSettings> = {},
  onPurge: (clock: FakeClock) => void = () => undefined,
) {
  const clock = new FakeClock('2026-10-12T00:00:00Z');
  const calls: PurgeCall[] = [];
  const counts = new Map<string, number>();
  const uow: UnitOfWork = {
    run: (work) => {
      const retention: RetentionRepository = {
        purge: async (policy, cutoff, batchSize, dryRun) => {
          const call = { policy, cutoff, batchSize, dryRun };
          calls.push(call);
          onPurge(clock);
          const nth = counts.get(policy) ?? 0;
          counts.set(policy, nth + 1);
          return respond(call, nth);
        },
      };
      return work({ retention } as unknown as Repositories);
    },
  };
  const metrics = new RecordingMetrics();
  const warnings: object[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (details) => void warnings.push(details),
  };
  const useCase = new RunRetention({ uow, clock, metrics, log, settings: settings(overrides) });
  return { useCase, calls, metrics, warnings, clock };
}

describe('RunRetention', () => {
  it('uses the per-policy cutoff computed from the run start', async () => {
    const { useCase, calls } = setup();
    await useCase.execute();
    expect(calls.map((c) => [c.policy, c.cutoff.toISOString()])).toEqual([
      ['webhook_attempts', '2026-09-12T00:00:00.000Z'],
      ['webhook_events', '2026-09-12T00:00:00.000Z'],
      ['idempotency_keys', '2026-07-14T00:00:00.000Z'],
    ]);
    expect(calls.map((c) => c.policy)).toEqual([...PAYMENT_RETENTION_POLICIES]);
  });

  it('dry-run makes exactly one counting call per policy', async () => {
    const { useCase, calls } = setup(() => 7, { dryRun: true });
    const report = await useCase.execute();
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.dryRun)).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.rows).toHaveLength(3);
    expect(report.rows.every((r) => r.count === 7)).toBe(true);
  });

  it('a real run drains a policy batch by batch', async () => {
    const script = [1000, 1000, 5];
    const { useCase, calls } = setup((c, nth) =>
      c.policy === 'webhook_events' ? (script[nth] ?? 0) : 0,
    );
    const report = await useCase.execute();
    expect(calls.filter((c) => c.policy === 'webhook_events')).toHaveLength(3);
    expect(calls.every((c) => !c.dryRun)).toBe(true);
    expect(report.rows).toEqual([{ table: 'webhook_events', count: 2005 }]);
  });

  it('stops without an error once the time budget is spent', async () => {
    const { useCase, calls } = setup(
      () => 0,
      { maxSecondsPerRun: 45 },
      (clock) => clock.advance(30_000),
    );
    const report = await useCase.execute();
    // Lần 1 ở t=0, lần 2 ở t=30s (còn trong ngân sách), tại t=60s thì dừng.
    expect(calls).toHaveLength(2);
    expect(report.errors).toBe(0);
  });

  it('does nothing when the signal is already aborted but still reports', async () => {
    const { useCase, calls, metrics } = setup();
    const controller = new AbortController();
    controller.abort();
    const report = await useCase.execute(controller.signal);
    expect(calls).toHaveLength(0);
    expect(report).toEqual({ dryRun: false, rows: [], errors: 0 });
    expect(metrics.calls).toEqual([['retentionRun', report]]);
  });

  it('isolates a failing policy and keeps the rows it deleted before failing', async () => {
    const { useCase, calls, warnings } = setup((c, nth) => {
      if (c.policy === 'webhook_attempts') {
        if (nth === 0) return 1000;
        throw new Error('deadlock');
      }
      return 0;
    });
    const report = await useCase.execute();
    expect(report.errors).toBe(1);
    expect(report.rows).toEqual([{ table: 'webhook_attempts', count: 1000 }]);
    // Chính sách lỗi không chặn các chính sách sau nó.
    expect(calls.map((c) => c.policy)).toEqual([
      'webhook_attempts',
      'webhook_attempts',
      'webhook_events',
      'idempotency_keys',
    ]);
    expect(warnings).toEqual([expect.objectContaining({ policy: 'webhook_attempts' })]);
  });

  it('records the report once and swallows a failing metrics sink', async () => {
    const ok = setup((c) => (c.policy === 'idempotency_keys' ? 3 : 0));
    const report = await ok.useCase.execute();
    expect(ok.metrics.calls).toEqual([['retentionRun', report]]);
    expect(report.rows).toEqual([{ table: 'idempotency_keys', count: 3 }]);

    const bad = setup();
    bad.metrics.retentionRun = () => {
      throw new Error('exporter down');
    };
    await expect(bad.useCase.execute()).resolves.toEqual({ dryRun: false, rows: [], errors: 0 });
    expect(bad.warnings).toHaveLength(1);
  });
});
