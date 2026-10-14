import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPerfConfig } from '../support/config.js';
import { createPerfEnv, DEFAULT_POOL_MAX, type PerfEnv } from '../support/perf-env.js';
import { runAndReport } from '../support/runner.js';
import { topupApplyScenario } from '../support/scenarios.js';

// Cấu hình đọc từ PERF_*; PERF_SCENARIOS (nếu đặt) chọn kịch bản chạy.
const config = loadPerfConfig(process.env);
const enabled = config.scenarios === null || config.scenarios.includes(topupApplyScenario.name);

describe.skipIf(!enabled)('kịch bản topup-apply', () => {
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
    const report = await runAndReport(env, config, topupApplyScenario);
    expect(report.valid).toBe(true);
  });
});
