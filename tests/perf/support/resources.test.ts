import { describe, expect, it } from 'vitest';
import {
  describeResources,
  parseCpuPercent,
  pickSqlContainer,
  startResourceMonitor,
  summarizeSamples,
} from './resources.js';

describe('parseCpuPercent', () => {
  it('đọc phần trăm của docker stats, kể cả > 100%', () => {
    expect(parseCpuPercent('12.34%')).toBe(12.34);
    expect(parseCpuPercent(' 215.07%\n')).toBe(215.07);
    expect(parseCpuPercent('0%')).toBe(0);
  });

  it('chuỗi lạ → null', () => {
    expect(parseCpuPercent('--')).toBeNull();
    expect(parseCpuPercent('')).toBeNull();
  });
});

describe('summarizeSamples', () => {
  it('trung bình, lớn nhất và số mẫu; rỗng → null', () => {
    expect(summarizeSamples([10, 30, 20])).toEqual({ mean: 20, max: 30, samples: 3 });
    expect(summarizeSamples([])).toBeNull();
  });
});

describe('pickSqlContainer', () => {
  it('chọn đúng một container testcontainers, bỏ billing-local-*', () => {
    expect(
      pickSqlContainer([
        'abc123 billing-local-sqlserver-1 mcr.microsoft.com/mssql/server:2022-latest',
        'def456 eager_turing mcr.microsoft.com/mssql/server:2022-latest',
      ]),
    ).toBe('def456');
  });

  it('không có hoặc nhiều hơn một ứng viên → null (không đoán)', () => {
    expect(pickSqlContainer([])).toBeNull();
    expect(pickSqlContainer(['a x img', 'b y img'])).toBeNull();
    expect(pickSqlContainer(['   '])).toBeNull();
  });
});

describe('startResourceMonitor', () => {
  it('đo CPU của Node và độ trễ vòng lặp sự kiện; tắt lấy mẫu SQL thì sqlCpuPercent = null', async () => {
    const monitor = startResourceMonitor({ sqlSampleIntervalMs: false });
    const until = performance.now() + 60;
    while (performance.now() < until) {
      // bận CPU có chủ ý
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    const usage = await monitor.stop();
    expect(usage.wallSeconds).toBeGreaterThan(0.05);
    expect(usage.nodeCpuSeconds).toBeGreaterThan(0.03);
    expect(usage.nodeCpuPercent).toBeGreaterThan(0);
    expect(usage.eventLoopDelayMs.max).toBeGreaterThanOrEqual(usage.eventLoopDelayMs.p50);
    expect(usage.sqlCpuPercent).toBeNull();
    expect(describeResources(usage)).toContain('CPU SQL: n/a');
  });
});
