import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadParams, mergeParams, ParamsError, type Params } from './params.js';

const DEFAULTS_PATH = resolve(import.meta.dirname, '../../deploy/kibana/params.defaults.json');

// File defaults đã commit, dùng để so sánh và làm nền cho các ghi đè.
const defaults = JSON.parse(await readFile(DEFAULTS_PATH, 'utf8')) as Params;

async function tmpFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kibana-params-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

// Trả về danh sách lỗi khi gộp local lên defaults (rỗng nếu hợp lệ).
function problemsOf(local: unknown): string[] {
  try {
    mergeParams(defaults, local);
  } catch (e) {
    if (e instanceof ParamsError) return e.problems;
    throw e;
  }
  return [];
}

describe('kibana params', () => {
  it('loads defaults equal to the committed JSON', async () => {
    const params = await loadParams({ defaultsPath: DEFAULTS_PATH });
    expect(params).toEqual(defaults);
  });

  it('keeps other defaults when overriding one nested key', () => {
    const p = mergeParams(defaults, {
      rules: { 'billing-outbox-stuck': { thresholdSeconds: 60 } },
    });
    expect(p.rules['billing-outbox-stuck'].thresholdSeconds).toBe(60);
    expect(p.rules['billing-outbox-stuck'].severity).toBe('high');
    expect(p.rules['billing-dlq-not-empty']).toEqual(defaults.rules['billing-dlq-not-empty']);
    expect(p.dashboard).toEqual(defaults.dashboard);
  });

  it('rejects unknown rule names, unknown keys and unknown top-level keys', () => {
    expect(problemsOf({ rules: { 'billing-nope': { enabled: true } } })).toEqual([
      'rules.billing-nope: unknown key',
    ]);
    expect(problemsOf({ rules: { 'billing-dlq-not-empty': { minDepht: 1 } } })).toEqual([
      'rules.billing-dlq-not-empty.minDepht: unknown key',
    ]);
    expect(problemsOf({ extra: 1 })).toEqual(['extra: unknown key']);
    expect(problemsOf({ dashboard: { foo: 1 } })).toEqual(['dashboard.foo: unknown key']);
  });

  it('rejects wrong types', () => {
    const p = problemsOf({
      rules: { 'billing-dlq-not-empty': { enabled: 'yes', intervalMinutes: '1', minDepth: 1.5 } },
    });
    expect(p).toEqual([
      'rules.billing-dlq-not-empty.enabled: must be boolean',
      'rules.billing-dlq-not-empty.intervalMinutes: must be an integer',
      'rules.billing-dlq-not-empty.minDepth: must be an integer',
    ]);
  });

  const ranges: [string, string, number, number][] = [
    ['billing-dlq-not-empty', 'intervalMinutes', 1, 60],
    ['billing-dlq-not-empty', 'windowMinutes', 1, 1440],
    ['billing-outbox-stuck', 'thresholdSeconds', 1, 604_800],
    ['billing-reconciliation-missed', 'maxAgeHours', 1, 720],
    ['billing-dlq-not-empty', 'minDepth', 0, 1_000_000],
    ['billing-ledger-integrity', 'minOpenItems', 0, 1_000_000],
    ['billing-service-silent', 'silentMinutes', 1, 1440],
    ['billing-service-silent', 'lookbackHours', 1, 168],
  ];
  it.each(ranges)('%s.%s boundaries', (rule, key, min, max) => {
    const at = (v: number): unknown => ({ rules: { [rule]: { [key]: v } } });
    const msg = `rules.${rule}.${key}: must be between ${min} and ${max}`;
    expect(problemsOf(at(min))).toEqual([]);
    expect(problemsOf(at(max))).toEqual([]);
    expect(problemsOf(at(min - 1))).toEqual([msg]);
    expect(problemsOf(at(max + 1))).toEqual([msg]);
  });

  it('rejects invalid severity and bad timeRange / refreshSeconds', () => {
    expect(problemsOf({ rules: { 'billing-outbox-stuck': { severity: 'low' } } })).toEqual([
      'rules.billing-outbox-stuck.severity: must be one of critical, high, warning',
    ]);
    expect(problemsOf({ dashboard: { timeRange: '6h' } })).toEqual([
      'dashboard.timeRange: must match now-<n>[mhd]',
    ]);
    expect(problemsOf({ dashboard: { timeRange: 'now-15m', refreshSeconds: 0 } })).toEqual([]);
    expect(problemsOf({ dashboard: { refreshSeconds: 3601 } })).toEqual([
      'dashboard.refreshSeconds: must be between 0 and 3600',
    ]);
  });

  it('reports several problems together in a stable order', () => {
    const local = {
      rules: {
        'billing-outbox-stuck': { thresholdSeconds: 0 },
        'billing-dlq-not-empty': { severity: 'x' },
      },
      dashboard: { timeRange: 'x' },
    };
    const expected = [
      'dashboard.timeRange: must match now-<n>[mhd]',
      'rules.billing-dlq-not-empty.severity: must be one of critical, high, warning',
      'rules.billing-outbox-stuck.thresholdSeconds: must be between 1 and 604800',
    ];
    expect(problemsOf(local)).toEqual(expected);
    expect(problemsOf(local)).toEqual(expected);
    expect(() => mergeParams(defaults, local)).toThrow(expected.join('\n'));
  });

  it('loadParams tolerates a missing local file', async () => {
    const params = await loadParams({
      defaultsPath: DEFAULTS_PATH,
      localPath: join(tmpdir(), 'no-such-dir', 'params.local.json'),
    });
    expect(params).toEqual(defaults);
  });

  it('loadParams applies a local file', async () => {
    const localPath = await tmpFile('params.local.json', '{"dashboard":{"refreshSeconds":10}}');
    const params = await loadParams({ defaultsPath: DEFAULTS_PATH, localPath });
    expect(params.dashboard).toEqual({ timeRange: 'now-6h', refreshSeconds: 10 });
  });

  it('loadParams names the file when local JSON is malformed', async () => {
    const localPath = await tmpFile('params.local.json', '{oops');
    const err = await loadParams({ defaultsPath: DEFAULTS_PATH, localPath }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ParamsError);
    expect((err as ParamsError).message).toContain(localPath);
  });

  it('a defaults file failing validation is a ParamsError', async () => {
    const bad = { ...defaults, dashboard: { timeRange: 'now-6h', refreshSeconds: -1 } };
    const defaultsPath = await tmpFile('bad.json', JSON.stringify(bad));
    await expect(loadParams({ defaultsPath })).rejects.toBeInstanceOf(ParamsError);
  });
});
