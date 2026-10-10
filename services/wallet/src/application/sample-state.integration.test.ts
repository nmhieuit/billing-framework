import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingMetrics } from '../test-support-metrics.js';
import { createHarness, seedTopup, silentLogger, type Harness } from '../test-support.js';
import type { Logger, QueueDepthReader, TenantUnitOfWork } from './ports.js';
import { SampleState } from './sample-state.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.000Z');
const before = (seconds: number) => new Date(t0.getTime() - seconds * 1000);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const reader = (value: number | null): QueueDepthReader => ({ depth: async () => value });

function build(
  overrides: { uow?: TenantUnitOfWork; queueDepth?: QueueDepthReader; log?: Logger } = {},
) {
  const metrics = new RecordingMetrics();
  const sampler = new SampleState({
    uow: overrides.uow ?? h.uow,
    registry: h.registry,
    queueDepth: overrides.queueDepth ?? reader(7),
    dlqQueue: 'dlq',
    metrics,
    clock: h.clock,
    log: overrides.log ?? silentLogger,
  });
  return { sampler, metrics };
}

// Test đầu seed dữ liệu cho acme (beta để trống); các test sau chỉ đọc.
describe('SampleState', () => {
  it('publishes ages from the clock, zeros for an empty tenant and the DLQ depth', async () => {
    h.clock.set(before(90));
    await seedTopup(h, { state: 'REQUESTED' });
    await h.uow.run(h.acme, async ({ outbox, reconciliation }) => {
      await outbox.add({
        id: 'ob1',
        eventType: 'e',
        routingKey: 'e',
        payload: '{}',
        correlationId: 'c',
        createdAt: before(30),
      });
      await reconciliation.startRun({
        id: 'run-s',
        day: '2026-10-01',
        triggeredBy: 'MANUAL',
        startedAt: before(600),
      });
      await reconciliation.completeRun('run-s', {
        gatewayTotals: {},
        walletTotals: {},
        items: [
          {
            id: 'it1',
            kind: 'UNKNOWN_CHARGE',
            chargeId: 'ch1',
            topupId: null,
            amountGateway: 1,
            amountWallet: null,
            currency: 'VND',
            detail: {},
            action: 'NONE',
          },
        ],
        finishedAt: before(300),
      });
    });
    h.clock.set(t0);

    const { sampler, metrics } = build();
    const state = await sampler.execute();

    expect(metrics.calls).toEqual([['publishState', state]]);
    expect(state.dlqDepth).toBe(7);
    expect(state.tenants.find((x) => x.tenant === 'acme')).toEqual({
      tenant: 'acme',
      outboxPending: 1,
      outboxOldestAgeSeconds: 30,
      topupsRequestedBacklog: 1,
      topupsOldestRequestedAgeSeconds: 90,
      openItemsByKind: { UNKNOWN_CHARGE: 1 },
      oldestOpenItemAgeSeconds: 300,
      lastReconciliationSuccessAgeSeconds: 300,
    });
    expect(state.tenants.find((x) => x.tenant === 'beta')).toEqual({
      tenant: 'beta',
      outboxPending: 0,
      outboxOldestAgeSeconds: 0,
      topupsRequestedBacklog: 0,
      topupsOldestRequestedAgeSeconds: 0,
      openItemsByKind: {},
      oldestOpenItemAgeSeconds: 0,
      lastReconciliationSuccessAgeSeconds: null,
    });
  });

  it('reports a null DLQ depth when the reader returns null or throws', async () => {
    expect((await build({ queueDepth: reader(null) }).sampler.execute()).dlqDepth).toBeNull();
    const throwing: QueueDepthReader = {
      depth: async () => {
        throw new Error('broker down');
      },
    };
    expect((await build({ queueDepth: throwing }).sampler.execute()).dlqDepth).toBeNull();
  });

  it('skips a failing tenant, still publishes the others and logs a warning', async () => {
    const warnings: object[] = [];
    const log: Logger = { ...silentLogger, warn: (details) => void warnings.push(details) };
    const flaky: TenantUnitOfWork = {
      run: (tenant, work) =>
        h.uow.run(tenant, (repositories) =>
          work(
            tenant.value === 'beta'
              ? {
                  ...repositories,
                  state: {
                    snapshot: async () => {
                      throw new Error('beta is broken');
                    },
                  },
                }
              : repositories,
          ),
        ),
    };
    const { sampler, metrics } = build({ uow: flaky, log });
    const state = await sampler.execute();

    expect(state.tenants.map((x) => x.tenant)).toEqual(['acme']);
    expect(metrics.calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ tenantId: 'beta' });
  });
});
