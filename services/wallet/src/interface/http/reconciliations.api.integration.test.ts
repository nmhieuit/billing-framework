import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../app.module.js';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { BackgroundRuns } from '../../application/background-runs.js';
import { CreateWallet } from '../../application/create-wallet.js';
import { GetReconciliationRun } from '../../application/get-reconciliation-run.js';
import { GetTopup } from '../../application/get-topup.js';
import { GetWallet } from '../../application/get-wallet.js';
import { ListEntries } from '../../application/list-entries.js';
import { ListReconciliationItems } from '../../application/list-reconciliation-items.js';
import { RequestTopup } from '../../application/request-topup.js';
import { ResolveReconciliationItem } from '../../application/resolve-reconciliation-item.js';
import { RunReconciliation } from '../../application/run-reconciliation.js';
import { StartManualReconciliation } from '../../application/start-manual-reconciliation.js';
import { createHarness, seedTopup, silentLogger, type Harness } from '../../test-support.js';
import { FakeSettlement, chargeFor, startDay } from '../../test-support-reconciliation.js';
import { createApp } from './create-app.js';

let h: Harness;
let app: NestFastifyApplication;
let settlement: FakeSettlement;
let background: BackgroundRuns;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  settlement = new FakeSettlement();
  background = new BackgroundRuns(silentLogger);
  const apply = new ApplyPaymentResult({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
  });
  const run = new RunReconciliation({
    uow: h.uow,
    settlement,
    applyPayment: apply,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    options: { autofix: true, maxItems: 1000 },
  });
  const deps: AppDeps = {
    registry: h.registry,
    clock: h.clock,
    log: silentLogger,
    webhookSecret: 'whsec_test_secret_value',
    createWallet: new CreateWallet({ uow: h.uow, clock: h.clock }),
    getWallet: new GetWallet({ uow: h.uow }),
    listEntries: new ListEntries({ uow: h.uow }),
    requestTopup: new RequestTopup({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      submitter: { submitSoon: () => undefined },
    }),
    getTopup: new GetTopup({ uow: h.uow }),
    applyPaymentResult: apply,
    startReconciliation: new StartManualReconciliation({ run, background }),
    getReconciliationRun: new GetReconciliationRun({ uow: h.uow }),
    listReconciliationItems: new ListReconciliationItems({ uow: h.uow }),
    resolveReconciliationItem: new ResolveReconciliationItem({ uow: h.uow, clock: h.clock }),
  };
  app = await createApp(deps);
});
afterEach(async () => {
  await background.drain();
  await app.close();
});

const acme = { 'x-tenant-id': 'acme' };
const errorOf = (body: string): { code: string; message: string } =>
  (JSON.parse(body) as { error: { code: string; message: string } }).error;

async function startRun(day: string, headers: Record<string, string> = acme) {
  return app.inject({ method: 'POST', url: '/reconciliations', headers, payload: { date: day } });
}

describe('POST /reconciliations', () => {
  it('answers 202 with the run id, then the run completes in the background', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [
      chargeFor(topup),
      chargeFor(topup, { chargeId: 'ch_ghost', reference: 'tp_ghost' }),
    ]);

    const started = await startRun(day);
    expect(started.statusCode).toBe(202);
    const { runId, status } = started.json<{ runId: string; status: string }>();
    expect(status).toBe('RUNNING');
    await background.drain();

    const run = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}`,
      headers: acme,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      id: runId,
      day,
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      itemCount: 2,
    });

    const open = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?caseStatus=OPEN`,
      headers: acme,
    });
    expect(open.json<{ items: Array<{ kind: string }> }>().items.map((i) => i.kind)).toEqual([
      'UNKNOWN_CHARGE',
    ]);
    const resolved = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?caseStatus=RESOLVED`,
      headers: acme,
    });
    expect(resolved.json<{ items: Array<{ kind: string; action: string }> }>().items).toMatchObject(
      [{ kind: 'MISSING_AT_WALLET', action: 'AUTO_APPLIED' }],
    );
  });

  it('rejects a bad date with 422 and a bad body with 400', async () => {
    const day = startDay(h);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const date of [tomorrow, '2027-02-30', 'yesterday', '']) {
      const res = await startRun(date);
      expect(res.statusCode, date).toBe(422);
      expect(errorOf(res.body).code).toBe('INVALID_RECONCILIATION');
    }
    const missing = await app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: acme,
      payload: {},
    });
    expect(missing.statusCode).toBe(422);
    const notObject = await app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: { ...acme, 'content-type': 'application/json' },
      payload: JSON.stringify([1]),
    });
    expect(notObject.statusCode).toBe(400);
  });

  it('needs a known tenant', async () => {
    const day = startDay(h);
    expect((await startRun(day, {})).statusCode).toBe(400);
    expect(errorOf((await startRun(day, {})).body).code).toBe('MISSING_TENANT');
    const unknown = await startRun(day, { 'x-tenant-id': 'nobody' });
    expect(unknown.statusCode).toBe(403);
    expect(errorOf(unknown.body).code).toBe('UNKNOWN_TENANT');
  });
});

describe('reading runs and items', () => {
  it('404s for unknown runs and hides runs of other tenants', async () => {
    const day = startDay(h);
    const started = await startRun(day);
    const { runId } = started.json<{ runId: string }>();
    await background.drain();

    for (const url of [`/reconciliations/nope`, `/reconciliations/nope/items`]) {
      const res = await app.inject({ method: 'GET', url, headers: acme });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res.body).code).toBe('RECONCILIATION_NOT_FOUND');
    }
    const other = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}`,
      headers: { 'x-tenant-id': 'beta' },
    });
    expect(other.statusCode).toBe(404);
  });

  it('pages items and validates the query', async () => {
    const day = startDay(h);
    const a = await seedTopup(h, { state: 'PENDING', amount: 1000 });
    const b = await seedTopup(h, { state: 'PENDING', amount: 2000 });
    settlement.set(day, [chargeFor(a, { amount: 1500 }), chargeFor(b, { amount: 2500 })]);
    const { runId } = (await startRun(day)).json<{ runId: string }>();
    await background.drain();

    const first = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?limit=1`,
      headers: acme,
    });
    const page1 = first.json<{ items: Array<{ kind: string }>; nextCursor: string | null }>();
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?limit=1&cursor=${page1.nextCursor}`,
      headers: acme,
    });
    const page2 = second.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    for (const query of [
      'limit=0',
      'limit=abc',
      'cursor=x',
      'caseStatus=DONE',
      'limit=1&limit=2',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/reconciliations/${runId}/items?${query}`,
        headers: acme,
      });
      expect(res.statusCode, query).toBe(400);
      expect(errorOf(res.body).code).toBe('INVALID_QUERY');
    }
  });
});

describe('POST /reconciliation-items/:id/resolve', () => {
  async function openItem(): Promise<string> {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 1000 });
    settlement.set(day, [chargeFor(topup, { amount: 1500 })]);
    const { runId } = (await startRun(day)).json<{ runId: string }>();
    await background.drain();
    const items = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items`,
      headers: acme,
    });
    return items.json<{ items: Array<{ id: string }> }>().items[0]!.id;
  }
  const resolve = (id: string, payload: unknown, headers: Record<string, string> = acme) =>
    app.inject({
      method: 'POST',
      url: `/reconciliation-items/${id}/resolve`,
      headers,
      payload: payload as object,
    });

  it('closes a case, is idempotent, and 409s on a different resolution', async () => {
    const id = await openItem();
    const body = { status: 'RESOLVED', note: 'adjusted by finance', resolvedBy: 'ops-1' };

    const first = await resolve(id, body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id,
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
      resolutionNote: 'adjusted by finance',
    });
    expect((await resolve(id, body)).json()).toEqual(first.json());

    const conflict = await resolve(id, { ...body, status: 'IGNORED' });
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict.body).code).toBe('RECONCILIATION_CONFLICT');
  });

  it('validates the body with 422 and finds items only in the caller tenant', async () => {
    const id = await openItem();
    for (const bad of [
      { status: 'RESOLVED', resolvedBy: 'ops' },
      { status: 'RESOLVED', note: '   ', resolvedBy: 'ops' },
      { status: 'OPEN', note: 'x', resolvedBy: 'ops' },
      { status: 'RESOLVED', note: 'x' },
      { status: 'RESOLVED', note: 'x'.repeat(501), resolvedBy: 'ops' },
    ]) {
      const res = await resolve(id, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
    const missing = await resolve('nope', { status: 'RESOLVED', note: 'x', resolvedBy: 'ops' });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('RECONCILIATION_ITEM_NOT_FOUND');
    const otherTenant = await resolve(
      id,
      { status: 'RESOLVED', note: 'x', resolvedBy: 'ops' },
      { 'x-tenant-id': 'beta' },
    );
    expect(otherTenant.statusCode).toBe(404);
  });
});
