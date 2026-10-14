import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { loadPerfConfig } from '../support/config.js';
import { runE2e } from '../support/e2e.js';
import { createPerfEnv, DEFAULT_POOL_MAX, type PerfEnv } from '../support/perf-env.js';
import { writeReport, type ScenarioResult } from '../support/report.js';
import {
  collectReport,
  describeRunMachine,
  ensureCustomers,
  readSqlServerVersion,
  reportFileName,
  runScenario,
  type ScenarioDefinition,
} from '../support/runner.js';
import { SCENARIOS } from '../support/scenarios.js';

// Ma trận đầy đủ theo PerfConfig mặc định (hoặc PERF_*): ba kịch bản use case dùng chung MỘT PerfEnv, rồi đầu-cuối, gộp thành
// một PerfReport ghi vào `<PERF_OUT>/report-<nhãn máy>-<thời điểm>.json/.md`. Không có ngưỡng thông lượng: chỉ khẳng định
// báo cáo đầy đủ và hợp lệ. Chạy riêng: `corepack pnpm test:perf matrix`. PERF_SCENARIOS (nếu đặt) phải gồm "matrix".
const config = loadPerfConfig(process.env);
const enabled = config.scenarios === null || config.scenarios.includes('matrix');

/** Ma trận mặc định kéo dài ~30-60 phút; vượt testTimeout chung (1 giờ) của vitest.perf.config.ts thì vẫn chưa coi là treo. */
const MATRIX_TIMEOUT_MS = 3 * 3_600_000;

/**
 * Loại chờ NGOÀI khóa ghi kèm mỗi lượt (vào ghi chú báo cáo), để so trần thông lượng với sàn commit/ghi log (WRITELOG), vòng
 * mạng tới client (ASYNC_NETWORK_IO) và tranh chấp trang/CPU. Bảng chờ khóa LCK_M_* vẫn do runner ghi trong RepeatResult.waits.
 */
const EXTRA_WAIT_TYPES = [
  'WRITELOG',
  'LOGBUFFER',
  'ASYNC_NETWORK_IO',
  'PAGELATCH_EX',
  'PAGELATCH_SH',
  'PAGEIOLATCH_SH',
  'PAGEIOLATCH_EX',
  'SOS_SCHEDULER_YIELD',
] as const;

type WaitCounters = Record<string, { waitMs: number; count: number }>;

async function snapshotExtraWaits(admin: Kysely<unknown>): Promise<WaitCounters> {
  const result = await sql<{
    wait_type: string;
    wait_time_ms: unknown;
    waiting_tasks_count: unknown;
  }>`
    select wait_type, wait_time_ms, waiting_tasks_count
    from sys.dm_os_wait_stats
    where wait_type in (${sql.join(EXTRA_WAIT_TYPES.map((t) => sql.lit(t)))})`.execute(admin);
  const waits: WaitCounters = {};
  for (const row of result.rows) {
    waits[row.wait_type] = {
      waitMs: Number(row.wait_time_ms),
      count: Number(row.waiting_tasks_count),
    };
  }
  return waits;
}

function describeExtraWaits(before: WaitCounters, after: WaitCounters, ops: number): string {
  const parts: string[] = [];
  for (const type of EXTRA_WAIT_TYPES) {
    const a = after[type];
    const b = before[type] ?? { waitMs: 0, count: 0 };
    if (a === undefined) continue;
    const waitMs = a.waitMs - b.waitMs;
    const count = a.count - b.count;
    if (waitMs < 0 || count < 0 || (waitMs === 0 && count === 0)) continue;
    const avg = count === 0 ? 'n/a' : (waitMs / count).toFixed(2);
    const perOp = ops === 0 ? 'n/a' : (count / ops).toFixed(2);
    parts.push(`${type} ${waitMs} ms/${count} lần (TB ${avg} ms/lần, ${perOp} lần/thao tác)`);
  }
  return parts.length === 0 ? 'không ghi nhận' : parts.join('; ');
}

/**
 * Bọc một kịch bản để chụp các loại chờ ngoài khóa quanh phần tải của MỖI lượt: chụp trước khi thao tác đầu tiên chạy (mọi
 * luồng chờ lần chụp này, chỉ làm trễ khởi động nóng) và chụp lại trong cleanup() (sau khi tải đã xả và runner đã kiểm sổ cái).
 * Cửa sổ gồm khởi động nóng + đo + xả + kiểm sổ cái (đọc), KHÔNG gồm seed và CHECKPOINT. Không đổi task, verify hay hàng đợi.
 */
function withExtraWaits(scenario: ScenarioDefinition, notes: string[]): ScenarioDefinition {
  return {
    ...scenario,
    async prepare(env, cfg, plan) {
      const prepared = await scenario.prepare(env, cfg, plan);
      let before: Promise<WaitCounters> | undefined;
      let startedAt = 0;
      let ops = 0;
      return {
        ...prepared,
        task: async (context) => {
          if (before === undefined) {
            startedAt = performance.now();
            before = snapshotExtraWaits(env.admin);
          }
          await before;
          ops += 1;
          await prepared.task(context);
        },
        async cleanup() {
          try {
            if (before !== undefined) {
              const after = await snapshotExtraWaits(env.admin);
              const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
              notes.push(
                `kịch bản ${scenario.name}, mức ${plan.concurrency}, lần lặp ${plan.repeat}: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, ${seconds} s, ${ops} thao tác đã bắt đầu): ${describeExtraWaits(await before, after, ops)}`,
              );
            }
          } finally {
            await prepared.cleanup?.();
          }
        },
      };
    },
  };
}

/**
 * Ánh xạ tài khoản hệ thống → wait_resource dạng `KEY: <db>:<hobt> (<hash>)` để đọc được cột "tài nguyên chờ nhiều nhất"
 * (vd biết KEY nào là dòng MERCHANT). Chỉ đọc, chạy qua kết nối quản trị ngoài cửa sổ đo.
 */
async function describeSystemAccountKeys(env: PerfEnv): Promise<string[]> {
  const notes: string[] = [];
  for (const tenant of env.tenants) {
    const table = `t_${tenant.value}.accounts`;
    const result = await sql<{ id: string; resource: string }>`
      select a.id, concat('KEY: ', db_id(), ':', p.hobt_id, ' ', a.%%lockres%%) as resource
      from ${sql.id(`t_${tenant.value}`, 'accounts')} as a
      cross join (select hobt_id from sys.partitions
        where object_id = object_id(${table}) and index_id = 1) as p
      where a.id like 'system:%'
      order by a.id`.execute(env.admin);
    for (const row of result.rows) {
      notes.push(`khóa dòng tài khoản hệ thống ${tenant.value}/${row.id} = ${row.resource}`);
    }
  }
  return notes;
}

async function runUseCaseScenarios(): Promise<{
  results: ScenarioResult[];
  sqlServerVersion: string | null;
  keyNotes: string[];
}> {
  const env: PerfEnv = await createPerfEnv({
    tenants: config.tenants,
    poolMax: Math.max(DEFAULT_POOL_MAX, ...config.concurrency),
  });
  try {
    const sqlServerVersion = await readSqlServerVersion(env.admin);
    // Seed khách một lần trước mọi kịch bản (dùng chung, ngoài cửa sổ đo).
    await ensureCustomers(env, config);
    const keyNotes = await describeSystemAccountKeys(env);
    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      const extraNotes: string[] = [];
      const result = await runScenario(env, config, withExtraWaits(scenario, extraNotes));
      results.push({ ...result, notes: [...(result.notes ?? []), ...extraNotes] });
    }
    return { results, sqlServerVersion, keyNotes };
  } finally {
    await env.stop();
  }
}

describe.skipIf(!enabled)('ma trận đầy đủ (pay-order, topup-apply, mixed, e2e)', () => {
  it(
    'chạy mọi kịch bản × mức × lần lặp, gộp một báo cáo đầy đủ và hợp lệ',
    { timeout: MATRIX_TIMEOUT_MS },
    async () => {
      const startedAt = performance.now();
      const { results, sqlServerVersion, keyNotes } = await runUseCaseScenarios();
      // Đầu-cuối chạy SAU khi môi trường use case đã dọn, để hai tải không chồng nhau trên cùng instance.
      const e2e = await runE2e({
        orders: config.e2eOrders,
        concurrency: config.e2eConcurrency,
      });
      const report = collectReport(
        results,
        e2e.result,
        config,
        describeRunMachine(config, sqlServerVersion),
      );
      report.notes.push(
        ...keyNotes,
        `ma trận: tổng thời gian chạy (gồm seed, chuẩn bị, đầu-cuối) ${((performance.now() - startedAt) / 60_000).toFixed(1)} phút`,
      );
      const stamp = report.createdAt.replace(/[:.]/g, '-');
      // Ghi TRƯỚC khi khẳng định để kết quả vô hiệu vẫn còn dấu vết.
      const files = await writeReport(
        report,
        config.out,
        reportFileName('report', `${config.machine}-${stamp}`),
      );
      console.log(`báo cáo ma trận: ${files.json}, ${files.markdown}`);

      expect(report.scenarios.map((s) => s.name)).toEqual(SCENARIOS.map((s) => s.name));
      for (const scenario of report.scenarios) {
        expect(scenario.valid, `${scenario.name}: ${(scenario.notes ?? []).join('; ')}`).toBe(true);
        expect(scenario.levels.map((l) => l.concurrency)).toEqual([...config.concurrency]);
        for (const level of scenario.levels) {
          expect(level.repeats, `${scenario.name} mức ${level.concurrency}`).toHaveLength(
            config.repeats,
          );
        }
      }
      expect(report.e2e?.invariantsOk).toBe(true);
      expect(report.valid).toBe(true);
    },
  );
});
