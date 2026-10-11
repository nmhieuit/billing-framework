import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KibanaClient, KibanaError } from './client.js';
import { main } from './cli.js';
import { FakeKibana } from './fake-kibana.js';

const DEPLOY = resolve(import.meta.dirname, '../../deploy/kibana');
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kibana-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (m: string) => void out.push(m), error: (m: string) => void err.push(m) };
};
const clientFor = (fake: FakeKibana) =>
  new KibanaClient({
    baseUrl: 'http://k',
    fetchImpl: fake.fetchImpl,
    sleep: async () => undefined,
  });

describe('cli build', () => {
  it('writes both files equal to the committed ones with --defaults-only', async () => {
    const c = capture();
    const code = await main(['build', '--defaults-only', '--out', dir], c);
    expect(code).toBe(0);
    for (const f of ['billing-alerts.ndjson', 'billing-dashboard.ndjson']) {
      expect(await readFile(join(dir, f), 'utf8')).toBe(await readFile(join(DEPLOY, f), 'utf8'));
    }
  });

  it('applies the local override when present', async () => {
    const local = join(dir, 'local.json');
    await writeFile(
      local,
      JSON.stringify({ rules: { 'billing-outbox-stuck': { thresholdSeconds: 600 } } }),
    );
    const c = capture();
    expect(await main(['build', '--out', dir, '--params-local', local], c)).toBe(0);
    expect(await readFile(join(dir, 'billing-alerts.ndjson'), 'utf8')).toContain('600');
  });

  it('prints every parameter problem on its own line and returns 1', async () => {
    const local = join(dir, 'local.json');
    await writeFile(
      local,
      JSON.stringify({
        rules: {
          'billing-outbox-stuck': { thresholdSeconds: 0 },
          'billing-dlq-not-empty': { severity: 'x' },
        },
      }),
    );
    const c = capture();
    expect(await main(['build', '--out', dir, '--params-local', local], c)).toBe(1);
    expect(
      c.err
        .join('\n')
        .split('\n')
        .filter((l) => l.includes('billing-')).length,
    ).toBe(2);
  });
});

describe('cli apply', () => {
  it('--dry-run makes no write calls, prints the plan and exits 0', async () => {
    const fake = new FakeKibana();
    const c = capture();
    const code = await main(['apply', '--dry-run', '--defaults-only'], {
      ...c,
      client: clientFor(fake),
    });
    expect(code).toBe(0);
    expect(fake.writeCalls).toEqual([]);
    expect(c.out.join('\n')).toMatch(/create\s+billing-outbox-stuck/);
    expect(c.out.join('\n')).toMatch(/dashboard: would import \d+ objects \(dry run\)/);
  });

  it('applies rules and the dashboard, then reports unchanged on rerun', async () => {
    const fake = new FakeKibana();
    const deps = { ...capture(), client: clientFor(fake) };
    expect(await main(['apply', '--defaults-only'], deps)).toBe(0);
    expect(fake.rules.size).toBe(8);
    expect(fake.imports).toHaveLength(1);
    expect(fake.imports[0]!.overwrite).toBe(true);
    const c2 = capture();
    expect(await main(['apply', '--defaults-only'], { ...c2, client: clientFor(fake) })).toBe(0);
    expect(c2.out.filter((l) => l.startsWith('unchanged')).length).toBe(8);
    expect(c2.out.join('\n')).toMatch(/dashboard: imported \d+ objects/);
  });

  it('fails before touching anything when Kibana is older than the minimum, even in dry run', async () => {
    const fake = new FakeKibana({ version: '9.3.2' });
    const c = capture();
    const code = await main(['apply', '--dry-run', '--defaults-only'], {
      ...c,
      client: clientFor(fake),
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain(
      'Kibana 9.3.2 is older than the minimum 9.4.0 required by the generated ES|QL rules',
    );
    expect(fake.calls.every((x) => x.path === '/api/status')).toBe(true);
  });

  it('returns 1 and prints the message on a KibanaError', async () => {
    const fake = new FakeKibana({ importErrors: [{ id: 'd', error: { type: 'conflict' } }] });
    const c = capture();
    const code = await main(['apply', '--defaults-only'], { ...c, client: clientFor(fake) });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('conflict');
    const thrower = {
      ...capture(),
      client: Object.assign(clientFor(new FakeKibana()), {
        waitUntilAvailable: async () => {
          throw new KibanaError('boom');
        },
      }),
    };
    expect(await main(['apply', '--defaults-only'], thrower)).toBe(1);
    expect(thrower.err.join('\n')).toContain('boom');
  });
});

describe('cli usage', () => {
  it('prints usage and returns 2 for an unknown command', async () => {
    const c = capture();
    expect(await main(['frobnicate'], c)).toBe(2);
    expect(c.err.join('\n')).toMatch(/Usage:/);
    expect(await main([], capture())).toBe(2);
  });
});

describe('cli verify', () => {
  const esOk = async () => new Response(JSON.stringify({ columns: [], values: [] }));

  it('returns 0 after apply, 1 when the dashboard is missing, and rejects a bad timeout', async () => {
    const fake = new FakeKibana();
    const base = { client: clientFor(fake), esFetch: esOk };
    expect(
      await main(['apply', '--defaults-only'], { ...capture(), client: clientFor(fake) }),
    ).toBe(0);

    const ok = capture();
    expect(await main(['verify', '--defaults-only'], { ...ok, ...base })).toBe(0);
    expect(ok.out.every((l) => l.startsWith('PASS'))).toBe(true);

    fake.dashboards.clear();
    const bad = capture();
    expect(await main(['verify', '--defaults-only'], { ...bad, ...base })).toBe(1);
    expect(bad.out.some((l) => l.startsWith('FAIL'))).toBe(true);

    const usage = capture();
    expect(await main(['verify', '--timeout-seconds', '0'], { ...usage, ...base })).toBe(2);
  });

  it('times out with exit 1 when the expected alert never fires', async () => {
    const fake = new FakeKibana();
    await main(['apply', '--defaults-only'], { ...capture(), client: clientFor(fake) });
    let clock = 0;
    const c = capture();
    const code = await main(
      [
        'verify',
        '--defaults-only',
        '--expect-alert',
        'billing-dlq-not-empty',
        '--timeout-seconds',
        '2',
      ],
      {
        ...c,
        client: clientFor(fake),
        esFetch: esOk,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(code).toBe(1);
    expect(c.out.join('\n')).toMatch(
      /FAIL rule billing-dlq-not-empty has no active alert within 2 s/,
    );
  });
});
