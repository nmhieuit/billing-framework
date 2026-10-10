import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidReconciliationError } from '../domain/errors.js';
import { createHarness, type Harness } from '../test-support.js';
import {
  InvalidQueryError,
  ReconciliationConflictError,
  ReconciliationItemNotFoundError,
  ReconciliationNotFoundError,
} from './errors.js';
import type { NewReconciliationItem } from './ports.js';
import { GetReconciliationRun } from './get-reconciliation-run.js';
import { ListReconciliationItems } from './list-reconciliation-items.js';
import { ResolveReconciliationItem } from './resolve-reconciliation-item.js';
import { StartManualReconciliation } from './start-manual-reconciliation.js';
import { BackgroundRuns } from './background-runs.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.000Z');

const item = (
  id: string,
  overrides: Partial<NewReconciliationItem> = {},
): NewReconciliationItem => ({
  id,
  kind: 'AMOUNT_MISMATCH',
  chargeId: `ch_${id}`,
  topupId: `tp_${id}`,
  amountGateway: 2000,
  amountWallet: 1000,
  currency: 'VND',
  detail: { reason: id },
  action: 'NONE',
  ...overrides,
});

beforeAll(async () => {
  h = await createHarness();
  await h.uow.run(h.acme, async ({ reconciliation }) => {
    await reconciliation.startRun({
      id: 'run-1',
      day: '2026-10-09',
      triggeredBy: 'MANUAL',
      startedAt: t0,
    });
    await reconciliation.completeRun('run-1', {
      gatewayTotals: { VND: 2000 },
      walletTotals: { VND: 1000 },
      items: [
        item('i1'),
        item('i2'),
        item('i3', { action: 'AUTO_APPLIED', kind: 'MISSING_AT_WALLET' }),
      ],
      finishedAt: t0,
    });
  });
});
afterAll(async () => {
  await h.close();
});

describe('GetReconciliationRun', () => {
  it('returns the run as a JSON view and 404s for unknown or other-tenant runs', async () => {
    const get = new GetReconciliationRun({ uow: h.uow });
    expect(await get.execute({ tenant: h.acme, runId: 'run-1' })).toEqual({
      id: 'run-1',
      day: '2026-10-09',
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      failureReason: null,
      gatewayTotals: { VND: 2000 },
      walletTotals: { VND: 1000 },
      itemCount: 3,
      startedAt: '2026-10-10T10:00:00.000Z',
      finishedAt: '2026-10-10T10:00:00.000Z',
    });
    await expect(get.execute({ tenant: h.acme, runId: 'nope' })).rejects.toBeInstanceOf(
      ReconciliationNotFoundError,
    );
    await expect(get.execute({ tenant: h.beta, runId: 'run-1' })).rejects.toBeInstanceOf(
      ReconciliationNotFoundError,
    );
  });
});

describe('ListReconciliationItems', () => {
  const build = () => new ListReconciliationItems({ uow: h.uow });

  it('filters by case status and pages with an opaque-looking numeric cursor', async () => {
    const open = await build().execute({ tenant: h.acme, runId: 'run-1', caseStatus: 'OPEN' });
    expect(open.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(open.nextCursor).toBeNull();
    expect(open.items[0]).toMatchObject({
      kind: 'AMOUNT_MISMATCH',
      amountGateway: 2000,
      amountWallet: 1000,
      detail: { reason: 'i1' },
      caseStatus: 'OPEN',
      resolvedAt: null,
    });

    const page1 = await build().execute({ tenant: h.acme, runId: 'run-1', limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(page1.nextCursor).toMatch(/^\d+$/);
    const page2 = await build().execute({
      tenant: h.acme,
      runId: 'run-1',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.id)).toEqual(['i3']);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects bad queries and unknown runs', async () => {
    const use = build();
    for (const bad of [
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { cursor: 'abc' },
      { cursor: '-1' },
      { caseStatus: 'DONE' },
    ]) {
      await expect(
        use.execute({ tenant: h.acme, runId: 'run-1', ...(bad as object) } as never),
      ).rejects.toBeInstanceOf(InvalidQueryError);
    }
    await expect(use.execute({ tenant: h.acme, runId: 'nope' })).rejects.toBeInstanceOf(
      ReconciliationNotFoundError,
    );
  });
});

describe('ResolveReconciliationItem', () => {
  const resolve = () => new ResolveReconciliationItem({ uow: h.uow, clock: h.clock });
  const input = () => ({
    tenant: h.acme,
    itemId: 'i1',
    status: 'RESOLVED',
    note: 'refunded manually',
    resolvedBy: 'ops-1',
  });

  it('closes an open item and returns the same result when repeated', async () => {
    h.clock.set('2026-10-11T08:00:00.000Z');
    const first = await resolve().execute(input());
    expect(first).toMatchObject({
      id: 'i1',
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
      resolutionNote: 'refunded manually',
      resolvedAt: '2026-10-11T08:00:00.000Z',
    });
    h.clock.set('2026-10-11T09:00:00.000Z');
    expect(await resolve().execute(input())).toEqual(first);
  });

  it('answers 409 when the item was closed with different values, and for auto-applied items', async () => {
    await expect(
      resolve().execute({ ...input(), note: 'a different note' }),
    ).rejects.toBeInstanceOf(ReconciliationConflictError);
    await expect(resolve().execute({ ...input(), itemId: 'i3' })).rejects.toBeInstanceOf(
      ReconciliationConflictError,
    );
  });

  it('validates the input and finds the item only in its own tenant', async () => {
    for (const bad of [
      { note: '  ' },
      { note: 'x'.repeat(501) },
      { status: 'OPEN' },
      { resolvedBy: '' },
    ]) {
      await expect(resolve().execute({ ...input(), itemId: 'i2', ...bad })).rejects.toBeInstanceOf(
        InvalidReconciliationError,
      );
    }
    await expect(resolve().execute({ ...input(), itemId: 'nope' })).rejects.toBeInstanceOf(
      ReconciliationItemNotFoundError,
    );
    await expect(
      resolve().execute({ ...input(), tenant: h.beta, itemId: 'i2' }),
    ).rejects.toBeInstanceOf(ReconciliationItemNotFoundError);
  });

  it('serialises two simultaneous resolves of one item: one wins, the other repeats or conflicts', async () => {
    const results = await Promise.allSettled([
      resolve().execute({ ...input(), itemId: 'i2', note: 'first' }),
      resolve().execute({ ...input(), itemId: 'i2', note: 'second' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReconciliationConflictError);
  });
});

describe('StartManualReconciliation', () => {
  it('creates the run, returns its id at once and finishes it in the background', async () => {
    const finished: string[] = [];
    const background = new BackgroundRuns({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const start = new StartManualReconciliation({
      run: {
        begin: async ({ tenant, day }) => ({ tenant, runId: 'run-x', day }),
        finish: async (handle) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          finished.push(handle.runId);
          return {} as never;
        },
      },
      background,
    });
    expect(await start.execute({ tenant: h.acme, day: '2026-10-09' })).toEqual({
      runId: 'run-x',
      status: 'RUNNING',
    });
    expect(finished).toEqual([]);
    await background.drain();
    expect(finished).toEqual(['run-x']);
  });

  it('propagates an invalid day without starting anything in the background', async () => {
    const background = new BackgroundRuns({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const start = new StartManualReconciliation({
      run: {
        begin: async () => {
          throw new InvalidReconciliationError('date must not be in the future');
        },
        finish: async () => {
          throw new Error('must not run');
        },
      },
      background,
    });
    await expect(start.execute({ tenant: h.acme, day: '2999-01-01' })).rejects.toBeInstanceOf(
      InvalidReconciliationError,
    );
    await background.drain();
  });
});
