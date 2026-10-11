import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRules, diffRule, planRules } from './apply.js';
import { KibanaClient } from './client.js';
import { FakeKibana } from './fake-kibana.js';
import { loadParams, type Params } from './params.js';
import { buildRules, toAlertingBody } from './rules.js';

const defaultsPath = resolve(import.meta.dirname, '../../deploy/kibana/params.defaults.json');
const defaults = await loadParams({ defaultsPath });

const rulesFor = (mutate?: (p: Params) => void) => {
  const p = structuredClone(defaults);
  mutate?.(p);
  return buildRules(p);
};
const setup = () => {
  const fake = new FakeKibana();
  return { fake, client: new KibanaClient({ baseUrl: 'http://k', fetchImpl: fake.fetchImpl }) };
};
const OUTBOX = 'billing-outbox-stuck';

describe('applyRules', () => {
  it('creates all 9 rules on an empty Kibana', async () => {
    const { fake, client } = setup();
    const { changes } = await applyRules(client, rulesFor(), { dryRun: false });
    expect(changes).toHaveLength(9);
    expect(changes.every((c) => c.actions.join() === 'create')).toBe(true);
    expect(fake.rules.size).toBe(9);
  });

  it('is idempotent: the second run is all unchanged with zero writes', async () => {
    const { fake, client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    fake.calls.length = 0;
    const { changes } = await applyRules(client, rulesFor(), { dryRun: false });
    expect(changes.every((c) => c.actions.join() === 'unchanged')).toBe(true);
    expect(fake.writeCalls).toEqual([]);
  });

  it('updates only the changed rule in place', async () => {
    const { fake, client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    const changed = rulesFor((p) => {
      p.rules[OUTBOX].thresholdSeconds = 600;
    });
    const { changes } = await applyRules(client, changed, { dryRun: false });
    const touched = changes.filter((c) => c.actions.join() !== 'unchanged');
    expect(touched.map((c) => c.name)).toEqual([OUTBOX]);
    expect(touched[0]!.actions).toEqual(['update']);
    expect(touched[0]!.differences).toContain('params');
    expect(fake.rules.size).toBe(9);
    const stored = [...fake.rules.values()].find((r) => r.name === OUTBOX)!;
    expect(JSON.stringify(stored.params)).toContain('600');
  });

  it('sends no actions when creating and keeps hand-attached connectors when updating', async () => {
    const { fake, client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    const creates = fake.bodies.filter((c) => c.method === 'POST' && c.body.actions !== undefined);
    expect(creates).toHaveLength(9);
    expect(creates.every((c) => (c.body.actions as unknown[]).length === 0)).toBe(true);

    const stored = [...fake.rules.values()].find((r) => r.name === OUTBOX)!;
    stored.actions = [
      {
        group: 'query matched',
        id: 'connector-1',
        connector_type_id: '.index',
        params: { documents: [{ a: 1 }] },
        frequency: { summary: false, notify_when: 'onActionGroupChange', throttle: null },
        uuid: 'uuid-1',
      },
    ];
    const changed = rulesFor((p) => {
      p.rules[OUTBOX].thresholdSeconds = 600;
    });
    fake.bodies.length = 0;
    await applyRules(client, changed, { dryRun: false });
    const put = fake.bodies.find((c) => c.method === 'PUT')!;
    expect(put.body.actions).toEqual([
      {
        group: 'query matched',
        id: 'connector-1',
        params: { documents: [{ a: 1 }] },
        frequency: { summary: false, notify_when: 'onActionGroupChange', throttle: null },
        uuid: 'uuid-1',
      },
    ]);
    expect(fake.rules.get(stored.id)!.actions).toHaveLength(1);
    expect(JSON.stringify(fake.rules.get(stored.id)!.params)).toContain('600');
  });

  it('does not treat a difference in actions as drift', async () => {
    const { fake, client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    [...fake.rules.values()][0]!.actions = [{ group: 'g', id: 'c', params: {} }];
    fake.calls.length = 0;
    const { changes } = await applyRules(client, rulesFor(), { dryRun: false });
    expect(changes.every((c) => c.actions.join() === 'unchanged')).toBe(true);
    expect(fake.writeCalls).toEqual([]);
  });

  it('disables a currently enabled rule, then enables it again', async () => {
    const { fake, client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    const off = rulesFor((p) => {
      p.rules[OUTBOX].enabled = false;
    });
    const r1 = await applyRules(client, off, { dryRun: false });
    const c1 = r1.changes.find((c) => c.name === OUTBOX)!;
    expect(c1.actions).toEqual(['disable']);
    expect(c1.differences).toEqual(['enabled']);
    expect([...fake.rules.values()].find((r) => r.name === OUTBOX)!.enabled).toBe(false);

    const r2 = await applyRules(client, rulesFor(), { dryRun: false });
    expect(r2.changes.find((c) => c.name === OUTBOX)!.actions).toEqual(['enable']);
    expect([...fake.rules.values()].find((r) => r.name === OUTBOX)!.enabled).toBe(true);
  });

  it('combines update and disable when both params and enabled differ', async () => {
    const { client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    const both = rulesFor((p) => {
      p.rules[OUTBOX].enabled = false;
      p.rules[OUTBOX].thresholdSeconds = 700;
    });
    const { changes } = await applyRules(client, both, { dryRun: false });
    expect(changes.find((c) => c.name === OUTBOX)!.actions).toEqual(['update', 'disable']);
  });

  it('dry run reports the same plan but performs no writes', async () => {
    const { fake, client } = setup();
    const real = await planRules(client, rulesFor());
    expect(fake.writeCalls).toEqual([]);
    const dry = await applyRules(client, rulesFor(), { dryRun: true });
    expect(dry.changes).toEqual(real);
    expect(fake.writeCalls).toEqual([]);
    expect(fake.rules.size).toBe(0);

    await applyRules(client, rulesFor(), { dryRun: false });
    fake.calls.length = 0;
    const changed = rulesFor((p) => {
      p.rules[OUTBOX].thresholdSeconds = 600;
    });
    const dry2 = await applyRules(client, changed, { dryRun: true });
    expect(dry2.changes.find((c) => c.name === OUTBOX)!.actions).toEqual(['update']);
    expect(fake.writeCalls).toEqual([]);
  });

  it('restores a manually edited name and tags', async () => {
    const { fake, client } = setup();
    const rules = rulesFor();
    await applyRules(client, rules, { dryRun: false });
    const id = rules.find((r) => r.name === OUTBOX)!.id;
    const stored = fake.rules.get(id)!;
    stored.name = 'hand edited';
    stored.tags = ['billing', 'whatever'];
    const { changes } = await applyRules(client, rules, { dryRun: false });
    const c = changes.find((x) => x.id === id)!;
    expect(c.actions).toEqual(['update']);
    expect(c.differences).toEqual(expect.arrayContaining(['name', 'tags']));
    expect(fake.rules.get(id)!.name).toBe(OUTBOX);
  });

  it('lists billing-tagged rules that are not desired as orphans and never deletes them', async () => {
    const { fake, client } = setup();
    await applyRules(client, rulesFor(), { dryRun: false });
    fake.rules.set('stray', {
      ...structuredClone([...fake.rules.values()][0]!),
      id: 'stray',
      name: 'old-rule',
    });
    fake.rules.set('foreign', {
      ...structuredClone([...fake.rules.values()][0]!),
      id: 'foreign',
      name: 'other-team',
      tags: ['other'],
    });
    const { orphans } = await applyRules(client, rulesFor(), { dryRun: false });
    expect(orphans).toEqual([{ id: 'stray', name: 'old-rule' }]);
    expect(fake.rules.has('stray')).toBe(true);
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('diffRule', () => {
  const desired = toAlertingBody(rulesFor()[0]!);
  const existing = () => ({ id: 'x', ...structuredClone(desired) });

  it('returns nothing for an identical rule, ignoring tag order and extra server-side params', () => {
    const e = existing();
    e.tags = [...e.tags].reverse();
    (e.params as Record<string, unknown>).serverDefault = 1;
    expect(diffRule(e, desired)).toEqual([]);
  });

  it('reports schedule and enabled differences', () => {
    const e = existing();
    e.schedule = { interval: '99m' };
    e.enabled = !desired.enabled;
    expect(diffRule(e, desired)).toEqual(['schedule', 'enabled']);
  });
});
