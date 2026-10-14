import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadPerfConfig } from './config.js';

// Test thuần cho phần đọc/kiểm tra biến môi trường PERF_*.
describe('loadPerfConfig', () => {
  it('returns the documented defaults for an empty environment', () => {
    expect(loadPerfConfig({})).toEqual({
      concurrency: [1, 4, 16, 64],
      durationSeconds: 20,
      warmupSeconds: 3,
      repeats: 3,
      customers: 2000,
      tenants: 1,
      e2eOrders: 200,
      e2eConcurrency: 16,
      machine: hostname(),
      out: 'tests/perf/.out',
      scenarios: null,
    });
  });

  it('reads every variable when valid', () => {
    const cfg = loadPerfConfig({
      PERF_CONCURRENCY: '2, 8,32',
      PERF_DURATION_SECONDS: '5',
      PERF_WARMUP_SECONDS: '1',
      PERF_REPEATS: '2',
      PERF_CUSTOMERS: '50',
      PERF_TENANTS: '4',
      PERF_E2E_ORDERS: '10',
      PERF_E2E_CONCURRENCY: '3',
      PERF_MACHINE: 'laptop-a',
      PERF_OUT: 'tmp/out',
      PERF_SCENARIOS: 'topup, order-payment',
    });
    expect(cfg).toEqual({
      concurrency: [2, 8, 32],
      durationSeconds: 5,
      warmupSeconds: 1,
      repeats: 2,
      customers: 50,
      tenants: 4,
      e2eOrders: 10,
      e2eConcurrency: 3,
      machine: 'laptop-a',
      out: 'tmp/out',
      scenarios: ['topup', 'order-payment'],
    });
  });

  it('splits PERF_SCENARIOS on commas and drops blanks', () => {
    expect(loadPerfConfig({ PERF_SCENARIOS: 'a,,b ,' }).scenarios).toEqual(['a', 'b']);
  });

  it('treats blank optional variables as unset', () => {
    const cfg = loadPerfConfig({ PERF_REPEATS: '', PERF_SCENARIOS: '', PERF_MACHINE: ' ' });
    expect(cfg.repeats).toBe(3);
    expect(cfg.scenarios).toBeNull();
    expect(cfg.machine).toBe(hostname());
  });

  it.each([
    ['PERF_DURATION_SECONDS', 'abc'],
    ['PERF_DURATION_SECONDS', '0'],
    ['PERF_DURATION_SECONDS', '-3'],
    ['PERF_DURATION_SECONDS', '1.5'],
    ['PERF_WARMUP_SECONDS', 'x'],
    ['PERF_REPEATS', '0'],
    ['PERF_CUSTOMERS', '2e3'],
    ['PERF_TENANTS', '0'],
    ['PERF_E2E_ORDERS', 'NaN'],
    ['PERF_E2E_CONCURRENCY', '-1'],
    ['PERF_CONCURRENCY', '1,x'],
    ['PERF_CONCURRENCY', '1,0'],
    ['PERF_CONCURRENCY', ','],
    ['PERF_CONCURRENCY', '1,,4'],
  ])('rejects %s=%j and names the variable', (name, value) => {
    expect(() => loadPerfConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('rejects an unsafe integer', () => {
    expect(() => loadPerfConfig({ PERF_CUSTOMERS: '99999999999999999999' })).toThrow(
      /PERF_CUSTOMERS/,
    );
  });
});
