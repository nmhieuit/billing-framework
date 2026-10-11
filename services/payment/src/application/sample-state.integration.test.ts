import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecordingMetrics } from '../test-support-metrics.js';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import type { Logger, UnitOfWork } from './ports.js';
import { SampleState } from './sample-state.js';

let h: Harness;
const silentLogger: Logger = { warn: () => {} };

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set('2026-10-09T10:00:00.000Z');
});

function build(overrides: { uow?: UnitOfWork; log?: Logger } = {}) {
  const metrics = new RecordingMetrics();
  const sampler = new SampleState({
    uow: overrides.uow ?? h.uow,
    metrics,
    clock: h.clock,
    log: overrides.log ?? silentLogger,
  });
  return { sampler, metrics };
}

describe('SampleState', () => {
  it('publishes zeros when there is no pending webhook', async () => {
    const { sampler, metrics } = build();
    const state = await sampler.execute();
    expect(state).toEqual({ webhookPending: 0, webhookOldestAgeSeconds: 0 });
    expect(metrics.calls).toEqual([['publishState', state]]);
  });

  it('computes the age of the oldest pending webhook from the clock', async () => {
    const createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
    const completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
    for (const key of ['a', 'b']) {
      await createCharge.execute({
        idempotencyKey: key,
        amount: 1000,
        currency: 'VND',
        reference: `ref-${key}`,
      });
    }
    await completeDue.execute(1);
    h.clock.advanceSeconds(40);
    await completeDue.execute();
    h.clock.advanceSeconds(50);

    const { sampler, metrics } = build();
    const state = await sampler.execute();

    expect(state).toEqual({ webhookPending: 2, webhookOldestAgeSeconds: 90 });
    expect(metrics.calls).toHaveLength(1);
  });

  it('logs a warning and does not throw when the repository fails', async () => {
    const warnings: object[] = [];
    const log: Logger = { warn: (details) => void warnings.push(details) };
    const broken: UnitOfWork = {
      run: async () => {
        throw new Error('db down');
      },
    };
    const { sampler, metrics } = build({ uow: broken, log });

    await expect(sampler.execute()).resolves.toBeUndefined();
    // Gauge phải ngừng báo cáo thay vì giữ mẫu cũ.
    expect(metrics.calls).toEqual([['publishState', null]]);
    expect(warnings).toHaveLength(1);
  });
});
