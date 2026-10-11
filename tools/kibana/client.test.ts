import { describe, expect, it } from 'vitest';
import { KibanaClient, KibanaError, type UpdateBody } from './client.js';
import { FakeKibana } from './fake-kibana.js';
import { buildRules, toAlertingBody } from './rules.js';
import { loadParams } from './params.js';
import { resolve } from 'node:path';

const defaultsPath = resolve(import.meta.dirname, '../../deploy/kibana/params.defaults.json');
const sample = toAlertingBody(buildRules(await loadParams({ defaultsPath }))[0]!);

const make = (
  fake: FakeKibana,
  extra: Partial<ConstructorParameters<typeof KibanaClient>[0]> = {},
) => new KibanaClient({ baseUrl: 'http://k:5601/', fetchImpl: fake.fetchImpl, ...extra });

describe('KibanaClient', () => {
  it('creates, reads, updates and toggles a rule with the right verbs and paths', async () => {
    const fake = new FakeKibana();
    const client = make(fake);
    expect(await client.getRule('r1')).toBeNull();
    await client.createRule('r1', sample);
    expect((await client.getRule('r1'))?.name).toBe(sample.name);
    const update: UpdateBody = { ...sample, name: 'renamed' };
    await client.updateRule('r1', update);
    await client.setRuleEnabled('r1', false);
    await client.setRuleEnabled('r1', true);
    expect(fake.calls).toEqual([
      { method: 'GET', path: '/api/alerting/rule/r1' },
      { method: 'POST', path: '/api/alerting/rule/r1' },
      { method: 'GET', path: '/api/alerting/rule/r1' },
      { method: 'PUT', path: '/api/alerting/rule/r1' },
      { method: 'POST', path: '/api/alerting/rule/r1/_disable' },
      { method: 'POST', path: '/api/alerting/rule/r1/_enable' },
    ]);
    expect(fake.rules.get('r1')?.name).toBe('renamed');
  });

  it('sends kbn-xsrf on every request', async () => {
    const fake = new FakeKibana();
    const client = make(fake);
    await client.getRule('x');
    await client.createRule('x', sample);
    expect(fake.headers.every((h) => h['kbn-xsrf'] === 'true')).toBe(true);
  });

  it('PUT carries only name, tags, schedule, params and actions', async () => {
    const fake = new FakeKibana();
    const client = make(fake);
    await client.createRule('r1', sample);
    // Cố tình đưa body đầy đủ (kể cả rule_type_id, consumer, enabled); fake trả 400 nếu client để lọt.
    await expect(client.updateRule('r1', sample as unknown as UpdateBody)).resolves.toBeUndefined();
  });

  it('surfaces the response body in KibanaError', async () => {
    const fake = new FakeKibana();
    const client = make(fake);
    await client.createRule('r1', sample);
    const err = await client.createRule('r1', sample).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KibanaError);
    expect((err as KibanaError).status).toBe(409);
    expect((err as KibanaError).message).toContain('conflict');
    await expect(client.updateRule('nope', sample)).rejects.toThrow(/404.*not found/);
  });

  it('findRulesByTag filters exactly on the tag', async () => {
    const fake = new FakeKibana();
    const client = make(fake);
    await client.createRule('a', { ...sample, name: 'a', tags: ['billing', 'high'] });
    await client.createRule('b', { ...sample, name: 'b', tags: ['billing-extra'] });
    await client.createRule('c', { ...sample, name: 'c', tags: ['other'] });
    expect(await client.findRulesByTag('billing')).toEqual([{ id: 'a', name: 'a' }]);
  });

  it('imports saved objects as multipart with overwrite=true', async () => {
    const fake = new FakeKibana();
    const client = make(fake);
    const n = await client.importSavedObjects(
      '{"id":"1"}\n{"id":"2"}\n{"exportedCount":2}\n',
      true,
    );
    expect(n).toBe(2);
    expect(fake.imports).toEqual([
      { ndjson: '{"id":"1"}\n{"id":"2"}\n{"exportedCount":2}\n', overwrite: true },
    ]);
  });

  it('throws with per-object error text when success is false', async () => {
    const fake = new FakeKibana({
      importErrors: [{ id: 'x', error: { type: 'missing_references' } }],
    });
    const client = make(fake);
    await expect(client.importSavedObjects('{"id":"x"}\n', true)).rejects.toThrow(
      /missing_references/,
    );
  });

  it('reads the version from /api/status', async () => {
    const client = make(new FakeKibana({ version: '9.5.1' }));
    expect(await client.getVersion()).toBe('9.5.1');
  });

  it('waitUntilAvailable retries then succeeds', async () => {
    const fake = new FakeKibana({ statusLevels: ['unavailable', 'degraded', 'available'] });
    const sleeps: number[] = [];
    await make(fake, { sleep: async (ms) => void sleeps.push(ms) }).waitUntilAvailable(60_000);
    expect(sleeps.length).toBe(2);
  });

  it('waitUntilAvailable times out with KibanaError', async () => {
    const fake = new FakeKibana({ statusLevels: ['unavailable'] });
    let t = 0;
    const client = make(fake, { sleep: async (ms) => void (t += ms), now: () => t });
    await expect(client.waitUntilAvailable(5_000)).rejects.toBeInstanceOf(KibanaError);
  });

  it('waitUntilAvailable keeps retrying through network errors', async () => {
    let n = 0;
    const client = new KibanaClient({
      baseUrl: 'http://k',
      fetchImpl: async () => {
        n += 1;
        if (n < 3) throw new Error('ECONNREFUSED');
        return new Response(JSON.stringify({ status: { overall: { level: 'available' } } }));
      },
      sleep: async () => undefined,
    });
    await client.waitUntilAvailable(60_000);
    expect(n).toBe(3);
  });
});
