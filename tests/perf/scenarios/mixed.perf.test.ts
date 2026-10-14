import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPerfConfig } from '../support/config.js';
import { createPerfEnv, DEFAULT_POOL_MAX, type PerfEnv } from '../support/perf-env.js';
import { runAndReport } from '../support/runner.js';
import { mixedScenario } from '../support/scenarios.js';

// Cấu hình đọc từ PERF_*; PERF_SCENARIOS (nếu đặt) chọn kịch bản chạy.
const config = loadPerfConfig(process.env);
const enabled = config.scenarios === null || config.scenarios.includes(mixedScenario.name);

describe.skipIf(!enabled)('kịch bản mixed', () => {
  let env: PerfEnv;
  beforeAll(async () => {
    env = await createPerfEnv({
      tenants: config.tenants,
      poolMax: Math.max(DEFAULT_POOL_MAX, ...config.concurrency),
    });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('đo qua mọi mức đồng thời và ghi báo cáo một phần', async () => {
    const report = await runAndReport(env, config, mixedScenario);
    expect(report.notes.filter((n) => !n.includes('sampler'))).toEqual([]);
    expect(report.valid).toBe(true);
  });
});
