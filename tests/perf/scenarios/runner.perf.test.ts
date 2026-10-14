import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPerfConfig, type PerfConfig } from '../support/config.js';
import { runE2e } from '../support/e2e.js';
import { createPerfEnv, type PerfEnv } from '../support/perf-env.js';
import type { LedgerCounts } from '../support/validity.js';
import { BlockedSampler } from '../support/wait-stats.js';
import type { PerfReport } from '../support/report.js';
import {
  collectReport,
  describeRunMachine,
  ensureCustomers,
  readSqlServerVersion,
  runScenario,
  writePartialReport,
  type ScenarioDefinition,
} from '../support/runner.js';
import {
  mixedScenario,
  payOrderScenario,
  SCENARIOS,
  topupApplyScenario,
} from '../support/scenarios.js';

// Smoke thật (SQL Server qua testcontainers): tham số lấy từ PerfConfig dựng trong test, KHÔNG sửa process.env.
let outDir: string;
let config: PerfConfig;
let env: PerfEnv;
const extraEnvs: PerfEnv[] = [];

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'perf-runner-smoke-'));
  config = {
    ...loadPerfConfig({}),
    concurrency: [2],
    durationSeconds: 2,
    warmupSeconds: 1,
    repeats: 1,
    customers: 40,
    tenants: 1,
    e2eOrders: 10,
    e2eConcurrency: 4,
    machine: 'smoke',
    out: outDir,
    scenarios: null,
  };
  env = await createPerfEnv({ tenants: config.tenants });
});

afterAll(async () => {
  await env?.stop();
  while (extraEnvs.length > 0) await extraEnvs.pop()?.stop();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

/** Bọc một kịch bản: giữ nguyên prepare gốc rồi cho phép sửa phần đã chuẩn bị (verify, task). */
function wrap(
  scenario: ScenarioDefinition,
  adjust: (prepared: Awaited<ReturnType<ScenarioDefinition['prepare']>>) => {
    task?: Awaited<ReturnType<ScenarioDefinition['prepare']>>['task'];
    verify?: Awaited<ReturnType<ScenarioDefinition['prepare']>>['verify'];
  },
): ScenarioDefinition {
  return {
    ...scenario,
    async prepare(e, c, plan) {
      const prepared = await scenario.prepare(e, c, plan);
      return { ...prepared, ...adjust(prepared) };
    },
  };
}

describe('runner: smoke 2 giây mỗi kịch bản use case', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s chạy trọn vẹn: 1 mức x 1 lần lặp, ok > 0, không lỗi, báo cáo ghi được',
    async (name, scenario) => {
      const result = await runScenario(env, config, scenario);
      expect(result.name).toBe(name);
      expect(result.valid).toBe(true);
      expect(result.levels).toHaveLength(1);
      const level = result.levels[0]!;
      expect(level.concurrency).toBe(2);
      expect(level.repeats).toHaveLength(1);
      const repeat = level.repeats[0]!;
      expect(repeat.ok).toBeGreaterThan(0);
      expect(repeat.errors).toEqual({ deadlock: 0, timeout: 0, other: 0 });
      expect(repeat.throughputPerSec).toBeGreaterThan(0);
      expect(repeat.latency.count).toBe(repeat.ok);
      expect(typeof repeat.waits).toBe('object');
      expect(Array.isArray(repeat.blocked)).toBe(true);
      console.log(
        `[smoke] ${name} @2 luồng: ${repeat.throughputPerSec.toFixed(1)} ops/s, ok=${repeat.ok}, p95=${repeat.latency.p95.toFixed(1)} ms, lỗi=${JSON.stringify(repeat.errors)}`,
      );

      const machine = describeRunMachine(config, await readSqlServerVersion(env.admin));
      const report = collectReport([result], undefined, config, machine);
      expect(report.valid).toBe(true);
      const files = await writePartialReport(report, config, name);
      const parsed = JSON.parse(await readFile(files.json, 'utf8')) as PerfReport;
      expect(parsed.scenarios[0]?.name).toBe(name);
      expect(await readFile(files.markdown, 'utf8')).toContain(`## Kịch bản: ${name}`);
    },
  );

  it('khách seed một lần và dùng chung giữa các kịch bản', async () => {
    const first = await ensureCustomers(env, config);
    expect(await ensureCustomers(env, config)).toBe(first);
    const wallets = await sql<{ n: number }>`
      select count(*) as n from ${sql.id('t_perf1', 'accounts')} where id like ${'wallet%'}`.execute(
      env.admin,
    );
    // Ba kịch bản đã chạy ở trên mà vẫn chỉ có 40 ví (không seed lại theo kịch bản).
    expect(Number(wallets.rows[0]?.n)).toBe(40);
    await expect(ensureCustomers(env, { ...config, customers: 41 })).rejects.toThrow(
      /PERF_CUSTOMERS/,
    );
  });
});

describe('runner: lượt đo vô hiệu', () => {
  it('verify trả vi phạm → runScenario ném lỗi nêu kịch bản/mức/lần lặp', async () => {
    const broken = wrap(payOrderScenario, () => ({
      verify: () => ['giả lập: giảm số đếm sổ cái'],
    }));
    await expect(runScenario(env, config, broken)).rejects.toThrow(
      /Kết quả đo vô hiệu \(kịch bản pay-order, mức 2, lần lặp 1\).*giả lập: giảm số đếm sổ cái/s,
    );
  });

  it('verify thật bắt đếm lệch: bỏ qua một lần ghi sổ cái giữa chừng', async () => {
    // Xóa một dòng order_payments sau khi lượt chạy (qua verify bọc): số đếm sổ cái lệch với thao tác thành công.
    const tampered = wrap(payOrderScenario, (prepared) => ({
      verify: (result, before, after) =>
        prepared.verify(result, before, { ...after, orderPayments: after.orderPayments - 1 }),
    }));
    await expect(runScenario(env, config, tampered)).rejects.toThrow(
      /kịch bản pay-order.*order_payments/s,
    );
  });

  it('làm hỏng số dư giữa lượt đo (qua admin) → checkLedger bắt và ném lỗi', async () => {
    // Môi trường riêng vì số dư hỏng không được lây sang các test khác.
    const own = await createPerfEnv({ tenants: 1 });
    extraEnvs.push(own);
    let corrupted = false;
    const corrupting = wrap(payOrderScenario, (prepared) => ({
      task: async (context) => {
        await prepared.task(context);
        if (!corrupted) {
          corrupted = true;
          await sql`update top (1) ${sql.id('t_perf1', 'accounts')} set balance = balance + 7`.execute(
            own.admin,
          );
        }
      },
    }));
    await expect(runScenario(own, config, corrupting)).rejects.toThrow(
      /Kết quả đo vô hiệu \(kịch bản pay-order, mức 2, lần lặp 1\)/,
    );
    expect(corrupted).toBe(true);
  });

  it('mức đồng thời vượt poolMax bị từ chối TRƯỚC khi seed', async () => {
    const small = await createPerfEnv({ tenants: 1, poolMax: 4 });
    extraEnvs.push(small);
    const countAccounts = async (): Promise<number> =>
      Number(
        (
          await sql<{
            n: number;
          }>`select count(*) as n from ${sql.id('t_perf1', 'accounts')}`.execute(small.admin)
        ).rows[0]?.n,
      );
    const before = await countAccounts();
    await expect(
      runScenario(small, { ...config, concurrency: [2, 8] }, payOrderScenario),
    ).rejects.toThrow(/poolMax/);
    expect(await countAccounts()).toBe(before);
  });

  it('sampler luôn được dừng sau mỗi lượt, kể cả lượt bị vô hiệu', async () => {
    const started = vi.spyOn(BlockedSampler.prototype, 'start');
    const stopped = vi.spyOn(BlockedSampler.prototype, 'stop');
    try {
      await runScenario(env, config, payOrderScenario);
      const broken = wrap(payOrderScenario, () => ({ verify: () => ['giả lập'] }));
      await expect(runScenario(env, config, broken)).rejects.toThrow(/vô hiệu/);
      expect(started).toHaveBeenCalledTimes(2);
      expect(stopped).toHaveBeenCalledTimes(2);
    } finally {
      started.mockRestore();
      stopped.mockRestore();
    }
  });

  it('hàng đợi topup cạn → ném lỗi rõ ràng, không quay vòng', async () => {
    const starved = {
      ...topupApplyScenario,
      prepare: (e: PerfEnv, c: PerfConfig, plan: Parameters<ScenarioDefinition['prepare']>[2]) =>
        topupApplyScenario.prepare(e, c, { ...plan, maxOps: 3 }),
    };
    await expect(runScenario(env, config, starved)).rejects.toThrow(/hàng đợi topup cạn/);
  });

  it('không có thao tác thành công → lượt vô hiệu: valid=false kèm ghi chú, báo cáo vẫn dựng được (n/a)', async () => {
    const failing = wrap(payOrderScenario, () => ({
      task: () => Promise.reject(new Error('luôn lỗi')),
      verify: () => [],
    }));
    const result = await runScenario(env, config, failing);
    expect(result.valid).toBe(false);
    expect(result.notes?.join('\n')).toMatch(/kịch bản pay-order, mức 2, lần lặp 1/);
    const repeat = result.levels[0]!.repeats[0]!;
    expect(repeat.ok).toBe(0);
    expect(repeat.errors.other).toBeGreaterThan(0);
    const machine = describeRunMachine(config, null);
    const report = collectReport([result], undefined, config, machine);
    expect(report.valid).toBe(false);
    const files = await writePartialReport(report, config, 'invalid-case');
    const markdown = await readFile(files.markdown, 'utf8');
    expect(markdown).toContain('n/a');
    expect(markdown).not.toContain('NaN');
    expect(markdown).toContain('- Hợp lệ: không');
  });
});

describe('runner: mixed ghi nhận đủ loại thao tác', () => {
  it('một lượt mixed thực sự tạo cả khoản trả, nạp tiền và đảo giao dịch (sổ cái tăng đúng loại)', async () => {
    const seen: Array<{ before: LedgerCounts; after: LedgerCounts }> = [];
    const spy = wrap(mixedScenario, (prepared) => ({
      verify: (result, before, after) => {
        seen.push({ before, after });
        return prepared.verify(result, before, after);
      },
    }));
    // 4 giây (~vài trăm lệnh) để xác suất không có lệnh đảo (5%) gần như bằng 0.
    await runScenario(env, { ...config, durationSeconds: 4 }, spy);
    const { before, after } = seen[0]!;
    expect(after.orderPayments).toBeGreaterThan(before.orderPayments);
    expect(after.topupTransactions).toBeGreaterThan(before.topupTransactions);
    expect(after.reversalTransactions).toBeGreaterThan(before.reversalTransactions);
  });
});

describe('e2e smoke', () => {
  it('10 đơn, 4 luồng: bất biến đạt, có độ trễ và thông lượng', async () => {
    const { result, sqlServerVersion } = await runE2e({ orders: 10, concurrency: 4 });
    expect(result.orders).toBe(10);
    expect(result.concurrency).toBe(4);
    expect(result.invariantsOk).toBe(true);
    expect(result.throughputPerSec).toBeGreaterThan(0);
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p50Ms);
    console.log(
      `[smoke] e2e 10 đơn @4 luồng: ${result.throughputPerSec.toFixed(1)} đơn/s, p50=${result.p50Ms.toFixed(0)} ms, p95=${result.p95Ms.toFixed(0)} ms`,
    );
    const report = collectReport([], result, config, describeRunMachine(config, sqlServerVersion));
    expect(report.valid).toBe(true);
    const files = await writePartialReport(report, config, 'e2e');
    expect(await readFile(files.markdown, 'utf8')).toContain('- Bất biến: đạt');
  });
});
