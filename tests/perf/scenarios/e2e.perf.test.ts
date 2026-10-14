import { describe, expect, it } from 'vitest';
import { loadPerfConfig } from '../support/config.js';
import { runE2e } from '../support/e2e.js';
import { collectReport, describeRunMachine, writePartialReport } from '../support/runner.js';

// Cấu hình đọc từ PERF_*: PERF_E2E_ORDERS đơn, PERF_E2E_CONCURRENCY luồng gửi. PERF_SCENARIOS (nếu đặt) phải gồm "e2e".
const config = loadPerfConfig(process.env);
const enabled = config.scenarios === null || config.scenarios.includes('e2e');

describe.skipIf(!enabled)('kịch bản e2e (wallet + payment + broker thật, không tiêm lỗi)', () => {
  it('đo độ trễ từng đơn và thông lượng cả lô, bất biến hệ thống đạt, ghi báo cáo một phần', async () => {
    const { result, sqlServerVersion } = await runE2e({
      orders: config.e2eOrders,
      concurrency: config.e2eConcurrency,
    });
    const report = collectReport([], result, config, describeRunMachine(config, sqlServerVersion));
    await writePartialReport(report, config, 'e2e');
    expect(result.invariantsOk).toBe(true);
    expect(report.valid).toBe(true);
  });
});
