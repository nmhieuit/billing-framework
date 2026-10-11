import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRules } from './apply.js';
import { KibanaClient, type FetchImpl } from './client.js';
import { buildDashboard, dashboardQueries, renderDashboardNdjson } from './dashboard.js';
import { FakeKibana } from './fake-kibana.js';
import { loadParams, type Params } from './params.js';
import { buildRules } from './rules.js';
import { runVerify, type VerifyOptions } from './verify.js';

const defaultsPath = resolve(import.meta.dirname, '../../deploy/kibana/params.defaults.json');
const defaults = await loadParams({ defaultsPath });

interface EsCall {
  esql: string;
  params: unknown;
}

/** Elasticsearch giả: ghi lại câu truy vấn, trả lỗi 400 cho câu chứa `failOn`. */
const fakeEs = (failOn?: string, alerts: { total: number } | { status: number } = { total: 0 }) => {
  const calls: EsCall[] = [];
  const searches: Array<{ path: string; body: { query: { bool: { filter: unknown[] } } } }> = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(input);
    if (init?.method === 'POST' && url.pathname === '/.alerts-stack.alerts-default/_search') {
      searches.push({ path: url.pathname, body: JSON.parse(init.body as string) });
      if ('status' in alerts) return new Response('{}', { status: alerts.status });
      return new Response(JSON.stringify({ hits: { total: { value: alerts.total } } }), {
        status: 200,
      });
    }
    if (init?.method !== 'POST' || url.pathname !== '/_query') {
      return new Response('{}', { status: 404 });
    }
    const body = JSON.parse(init.body as string) as { query: string; params?: unknown };
    calls.push({ esql: body.query, params: body.params });
    if (failOn && body.query.includes(failOn)) {
      return new Response(
        JSON.stringify({ error: { reason: 'Found 1 problem: Unknown column [boom]' } }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ columns: [], values: [] }), { status: 200 });
  };
  return { calls, searches, fetchImpl };
};

/** Kibana đã apply đủ 9 rule và dashboard. */
async function appliedKibana(params: Params = defaults) {
  const fake = new FakeKibana();
  const client = new KibanaClient({
    baseUrl: 'http://k',
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
  });
  await applyRules(client, buildRules(params), { dryRun: false });
  await client.importSavedObjects(renderDashboardNdjson(buildDashboard(params)), true);
  return { fake, client };
}

const DLQ = 'billing-dlq-not-empty';

const run = async (
  over: Partial<VerifyOptions> & { fake: FakeKibana; client: KibanaClient },
  es = fakeEs(),
) => {
  const lines: string[] = [];
  let clock = 0;
  const ok = await runVerify({
    params: defaults,
    esUrl: 'http://es',
    esFetch: es.fetchImpl,
    timeoutMs: 5000,
    pollMs: 1000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (m) => void lines.push(m),
    ...over,
  });
  return { ok, lines, es };
};

describe('runVerify', () => {
  it('passes against a healthy stack and prints one PASS line per check', async () => {
    const { fake, client } = await appliedKibana();
    const { ok, lines } = await run({ fake, client });
    expect(ok).toBe(true);
    expect(lines.every((l) => l.startsWith('PASS'))).toBe(true);
    expect(lines.some((l) => l.includes(DLQ))).toBe(true);
    expect(lines.some((l) => /dashboard/i.test(l))).toBe(true);
  });

  it('sends the dashboard queries with _tstart/_tend and runs every generated query', async () => {
    const { fake, client } = await appliedKibana();
    const { es } = await run({ fake, client });
    const dashboard = dashboardQueries(buildDashboard(defaults));
    const rules = buildRules(defaults);
    expect(es.calls).toHaveLength(dashboard.length + rules.length);
    for (const q of dashboard) {
      const call = es.calls.find((c) => c.esql === q.esql)!;
      expect(call.params).toEqual([
        { _tstart: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string },
        { _tend: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string },
      ]);
    }
    for (const r of rules) expect(es.calls.some((c) => c.esql === r.esql)).toBe(true);
  });

  it('fails when a rule is in error status', async () => {
    const { fake, client } = await appliedKibana();
    const rule = [...fake.rules.values()].find((r) => r.name === DLQ)!;
    rule.execution_status = { status: 'error', error: { message: 'boom' } };
    const { ok, lines } = await run({ fake, client });
    expect(ok).toBe(false);
    expect(lines.find((l) => l.startsWith('FAIL'))).toMatch(new RegExp(`${DLQ}.*error`));
  });

  it('fails when a rule is missing', async () => {
    const { fake, client } = await appliedKibana();
    const rule = [...fake.rules.values()].find((r) => r.name === 'billing-outbox-stuck')!;
    fake.rules.delete(rule.id);
    const { ok, lines } = await run({ fake, client });
    expect(ok).toBe(false);
    expect(lines.find((l) => l.startsWith('FAIL'))).toMatch(/billing-outbox-stuck.*missing/);
  });

  it('fails when enabled does not match the parameters', async () => {
    const { fake, client } = await appliedKibana();
    [...fake.rules.values()][0]!.enabled = false;
    const { ok, lines } = await run({ fake, client });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.startsWith('FAIL') && /enabled/.test(l))).toBe(true);
  });

  it('fails when the dashboard is missing', async () => {
    const { fake, client } = await appliedKibana();
    fake.dashboards.clear();
    const { ok, lines } = await run({ fake, client });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.startsWith('FAIL') && /dashboard/i.test(l))).toBe(true);
  });

  it('fails with the query name when an ES|QL query is rejected', async () => {
    const { fake, client } = await appliedKibana();
    const target = buildRules(defaults).find((r) => r.name === 'billing-outbox-stuck')!;
    const marker = 'billing.outbox.oldest_age_seconds';
    expect(target.esql).toContain(marker);
    const { ok, lines } = await run({ fake, client }, fakeEs(marker));
    expect(ok).toBe(false);
    const failed = lines.filter((l) => l.startsWith('FAIL'));
    expect(
      failed.some((l) => l.includes('billing-outbox-stuck') && l.includes('Unknown column')),
    ).toBe(true);
  });

  describe('flapping check', () => {
    const withActive = async () => {
      const { fake, client } = await appliedKibana();
      const rule = [...fake.rules.values()].find((r) => r.name === 'billing-outbox-stuck')!;
      fake.rules.set(rule.id, { ...rule, last_run: { alerts_count: { active: 2 } } });
      return { fake, client, rule };
    };

    it('skips rules without active alerts (no query on the alerts index)', async () => {
      const { fake, client } = await appliedKibana();
      const { ok, es } = await run({ fake, client });
      expect(ok).toBe(true);
      expect(es.searches).toHaveLength(0);
    });

    it('queries recovered short-lived alerts of the active rule and passes when there is at most one', async () => {
      const { fake, client, rule } = await withActive();
      const { ok, lines, es } = await run({ fake, client }, fakeEs(undefined, { total: 1 }));
      expect(ok).toBe(true);
      expect(es.searches).toHaveLength(1);
      const filter = JSON.stringify(es.searches[0]!.body.query.bool.filter);
      expect(filter).toContain(rule.id);
      expect(filter).toContain('"recovered"');
      expect(filter).toContain('now-10m');
      expect(filter).toContain(String(2 * 60_000_000));
      expect(lines.some((l) => l.startsWith('PASS') && /alert ids are stable/.test(l))).toBe(true);
    });

    it('fails with a clear message when alerts recover as fast as they appear', async () => {
      const { fake, client } = await withActive();
      const { ok, lines } = await run({ fake, client }, fakeEs(undefined, { total: 2 }));
      expect(ok).toBe(false);
      expect(lines.find((l) => l.startsWith('FAIL'))).toMatch(
        /billing-outbox-stuck is flapping.*identity columns tenant/,
      );
    });

    it('fails when the alerts index cannot be read', async () => {
      const { fake, client } = await withActive();
      const { ok, lines } = await run({ fake, client }, fakeEs(undefined, { status: 404 }));
      expect(ok).toBe(false);
      expect(lines.find((l) => l.startsWith('FAIL'))).toMatch(/cannot read .*HTTP 404/);
    });
  });

  describe('--expect-alert', () => {
    it('passes once the rule has an active alert', async () => {
      const { fake } = await appliedKibana();
      const rule = [...fake.rules.values()].find((r) => r.name === DLQ)!;
      let polls = 0;
      const original = fake.fetchImpl;
      fake.rules.set(rule.id, { ...rule, last_run: { alerts_count: { active: 0 } } });
      const wrapped: FetchImpl = async (input, init) => {
        if (new URL(input).pathname === `/api/alerting/rule/${rule.id}`) {
          polls += 1;
          if (polls >= 3) {
            fake.rules.set(rule.id, { ...rule, last_run: { alerts_count: { active: 2 } } });
          }
        }
        return original(input, init);
      };
      const wrappedClient = new KibanaClient({ baseUrl: 'http://k', fetchImpl: wrapped });
      const { ok, lines } = await run({ fake, client: wrappedClient, expectAlert: DLQ });
      expect(ok).toBe(true);
      expect(lines.some((l) => l.startsWith('PASS') && /active alert/i.test(l))).toBe(true);
    });

    it('fails on timeout when no alert becomes active', async () => {
      const { fake, client } = await appliedKibana();
      const { ok, lines } = await run({ fake, client, expectAlert: DLQ, timeoutMs: 3000 });
      expect(ok).toBe(false);
      expect(lines.find((l) => l.startsWith('FAIL'))).toMatch(
        new RegExp(`${DLQ}.*no active alert within 3 s`),
      );
    });

    it('fails for an unknown rule name', async () => {
      const { fake, client } = await appliedKibana();
      const { ok, lines } = await run({ fake, client, expectAlert: 'nope' });
      expect(ok).toBe(false);
      expect(lines.find((l) => l.startsWith('FAIL'))).toMatch(/unknown rule nope/);
    });
  });
});
