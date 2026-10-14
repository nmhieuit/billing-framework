import { sql, type Kysely } from 'kysely';
import type { PerfConfig } from './config.js';
import { summarizeLatencies } from './histogram.js';
import { runClosedLoop, type DriverOptions, type DriverResult } from './load-driver.js';
import { describeMachine, type MachineInfo } from './machine.js';
import { assertConcurrencyFitsPool, type PerfEnv } from './perf-env.js';
import {
  buildLevelResult,
  writeReport,
  type E2eResult,
  type PerfReport,
  type RepeatResult,
  type ScenarioResult,
} from './report.js';
import { seedCustomers, type SeededCustomer } from './seed.js';
import { checkLedger, readLedgerCounts, type LedgerCounts } from './validity.js';
import { BlockedSampler, diffWaits, snapshotWaits } from './wait-stats.js';

/** Số dư khởi tạo của mỗi khách (VND): đủ để cả bộ đo (hàng trăm nghìn lệnh 1 000 VND) không bao giờ hết tiền. */
export const CUSTOMER_BALANCE = 1_000_000_000;
export const CURRENCY = 'VND';

/**
 * Cận trên THÔNG LƯỢNG dùng để cấp phát trước hàng đợi topup (đơn vị: thao tác/giây). Hàng đợi chỉ được seed MỘT lần mỗi lượt
 * trong prepare(), ngoài cửa sổ đo; hết hàng đợi là lỗi (không quay vòng). Hai trần:
 *  - mỗi luồng tối đa PER_WORKER_OPS_PER_SEC;
 *  - tổng tối đa TOTAL_OPS_PER_SEC.
 * Hiệu chuẩn trên máy phát triển (SQL Server trong container): ~30 thao tác/giây/luồng ở 2 luồng và tối đa ~65 thao tác/giây tổng
 * ở 16-64 luồng, nên hai trần cao hơn thực đo khoảng 2x và 6x. Nhân thêm SAFETY_FACTOR cho dao động. Từ lần lặp thứ hai của một
 * mức, runScenario thu hẹp theo thông lượng thực đo của lần lặp trước (observedMaxOps) để không seed thừa hàng chục nghìn
 * topup. Máy mạnh hơn nhiều thì lượt đo dừng với lỗi rõ ràng "hàng đợi topup cạn" (verify của topup-apply/mixed) chứ không đo
 * sai; khi đó nâng hằng số ở đây.
 */
export const PER_WORKER_OPS_PER_SEC = 60;
export const TOTAL_OPS_PER_SEC = 400;
export const SAFETY_FACTOR = 1.25;
/** Dư 50% so với thông lượng của lần lặp trước (dao động giữa các lần lặp). */
export const OBSERVED_FACTOR = 1.5;

/** Số thao tác tối đa dự kiến của một lượt (gồm khởi động nóng; cộng thêm các lệnh còn bay lúc hết cửa sổ). */
export function estimateMaxOps(concurrency: number, seconds: number): number {
  const perSecond = Math.min(concurrency * PER_WORKER_OPS_PER_SEC, TOTAL_OPS_PER_SEC);
  return Math.ceil(perSecond * seconds * SAFETY_FACTOR) + concurrency * 2;
}

/**
 * Cận trên theo thông lượng thực đo của lần lặp trước: (thao tác/giây trong cửa sổ đo) x (khởi động + đo) x OBSERVED_FACTOR,
 * không bao giờ vượt `ceiling` (cận tĩnh của estimateMaxOps).
 */
export function observedMaxOps(
  previous: { ok: number; errors: number },
  config: Pick<PerfConfig, 'durationSeconds' | 'warmupSeconds'>,
  concurrency: number,
  ceiling: number,
): number {
  const perSecond = (previous.ok + previous.errors) / config.durationSeconds;
  const bound = Math.ceil(
    perSecond * (config.warmupSeconds + config.durationSeconds) * OBSERVED_FACTOR,
  );
  return Math.min(ceiling, bound + concurrency * 2);
}

export interface ScenarioPlan {
  concurrency: number;
  /** Số thứ tự lần lặp, bắt đầu từ 1. */
  repeat: number;
  /** Khách đã seed (dùng chung cho mọi kịch bản/mức/lần lặp của một lần chạy; chỉ đọc). */
  customers: readonly SeededCustomer[];
  /** Cận trên số thao tác của lượt (khởi động + đo), để cấp phát trước trạng thái bị tiêu thụ (topup PENDING). */
  maxOps: number;
}

export interface PreparedScenario {
  task: DriverOptions['task'];
  /**
   * Sau lượt đo (không còn tải): đối chiếu hiệu số đếm sổ cái với số thao tác thành công THỰC TẾ của kịch bản; trả danh sách
   * vi phạm (rỗng = hợp lệ). Phải đếm TẤT CẢ thao tác đã thành công (cả lúc khởi động nóng và lúc xả), không phải DriverResult.ok
   * (chỉ tính trong cửa sổ đo), vì sổ cái chứa mọi thao tác.
   */
  verify(result: DriverResult, countsBefore: LedgerCounts, countsAfter: LedgerCounts): string[];
  cleanup?(): Promise<void>;
}

export interface ScenarioDefinition {
  name: 'pay-order' | 'topup-apply' | 'mixed';
  description: string;
  /** Dựng trạng thái của MỘT lần lặp (seed hàng đợi topup...). Thời gian này nằm NGOÀI cửa sổ đo. */
  prepare(env: PerfEnv, config: PerfConfig, plan: ScenarioPlan): Promise<PreparedScenario>;
}

// Khách seed một lần mỗi môi trường và dùng chung giữa các kịch bản/mức: seed tốn ~24 ms/khách.
const seeded = new WeakMap<PerfEnv, { count: number; customers: Promise<SeededCustomer[]> }>();

/** Seed `config.customers` khách đúng một lần cho `env` rồi trả lại chính tập đó ở các lần gọi sau. */
export async function ensureCustomers(env: PerfEnv, config: PerfConfig): Promise<SeededCustomer[]> {
  const existing = seeded.get(env);
  if (existing) {
    if (existing.count !== config.customers) {
      throw new Error(
        `môi trường đo đã seed ${existing.count} khách, không thể dùng lại với PERF_CUSTOMERS=${config.customers}`,
      );
    }
    return existing.customers;
  }
  const customers = seedCustomers(env, { count: config.customers, balance: CUSTOMER_BALANCE });
  seeded.set(env, { count: config.customers, customers });
  // Seed lỗi thì không giữ promise hỏng trong bộ nhớ đệm: lần gọi sau thử lại từ đầu.
  customers.catch(() => seeded.delete(env));
  return customers;
}

function invalidError(where: string, problems: string[]): Error {
  return new Error(`Kết quả đo vô hiệu (${where}): ${problems.join('; ')}`);
}

interface RepeatOutcome {
  result: RepeatResult;
  /** Lý do lượt không dùng được nhưng không phải vi phạm (vd không có thao tác thành công). */
  invalid: string[];
  info: string[];
}

async function runRepeat(
  env: PerfEnv,
  config: PerfConfig,
  scenario: ScenarioDefinition,
  plan: ScenarioPlan,
  where: string,
): Promise<RepeatOutcome> {
  // Thứ tự: prepare → đếm sổ cái (trước) → chụp wait + bật sampler → tải → tắt sampler + diff wait → xác nhận đã xả hết
  // → đếm sổ cái (sau) + checkLedger → verify. Tải chạy qua env.db; sampler và kiểm tra hợp lệ qua env.admin.
  const prepared = await scenario.prepare(env, config, plan);
  let primary: unknown;
  try {
    const before = await readLedgerCounts(env);
    let inFlight = 0;
    const task: DriverOptions['task'] = async (context) => {
      inFlight += 1;
      try {
        await prepared.task(context);
      } finally {
        inFlight -= 1;
      }
    };

    const waitsBefore = await snapshotWaits(env.admin);
    const sampler = new BlockedSampler(env.admin, { databaseName: env.databaseName });
    sampler.start();
    let driver: DriverResult;
    let blocked: Awaited<ReturnType<BlockedSampler['stop']>>;
    try {
      driver = await runClosedLoop({
        concurrency: plan.concurrency,
        durationMs: config.durationSeconds * 1000,
        warmupMs: config.warmupSeconds * 1000,
        task,
      });
    } finally {
      // Luôn dừng sampler (kể cả khi tải ném lỗi), nếu không vòng lấy mẫu rò rỉ sang lượt sau.
      blocked = await sampler.stop();
    }
    const waits = diffWaits(waitsBefore, await snapshotWaits(env.admin));

    if (inFlight !== 0) {
      throw invalidError(where, [`${inFlight} thao tác vẫn còn bay sau khi tải kết thúc`]);
    }

    const after = await readLedgerCounts(env);
    const problems = [...(await checkLedger(env)), ...prepared.verify(driver, before, after)];
    if (problems.length > 0) throw invalidError(where, problems);

    const latency = summarizeLatencies(driver.latenciesMs);
    const invalid: string[] = [];
    if (driver.ok === 0 || latency.count === 0) {
      invalid.push(
        `${where}: không có thao tác thành công nào trong cửa sổ đo (ok=${driver.ok}, mẫu độ trễ=${latency.count}; lỗi: ${JSON.stringify(driver.errors)})`,
      );
    }
    const info: string[] = [];
    if (sampler.errorCount > 0) {
      info.push(
        `${where}: sampler chờ khóa lỗi ${sampler.errorCount} lần (${sampler.sampleCount} lần lấy mẫu thành công): ${sampler.lastError ?? ''}`,
      );
    }
    return {
      result: {
        throughputPerSec: driver.throughputPerSec,
        ok: driver.ok,
        errors: driver.errors,
        latency,
        waits,
        blocked,
      },
      invalid,
      info,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await prepared.cleanup?.();
    } catch (cleanupError) {
      // Lỗi dọn không che lỗi gốc; nếu không có lỗi gốc thì báo lỗi dọn.
      if (primary === undefined) throw cleanupError;
    }
  }
}

/**
 * Chạy một kịch bản qua mọi mức đồng thời × số lần lặp. Mức vượt poolMax bị từ chối TRƯỚC khi seed bất cứ thứ gì.
 * Vi phạm sổ cái hoặc đối chiếu (checkLedger/verify) → ném lỗi nêu kịch bản/mức/lần lặp (kết quả đo vô hiệu). Lượt không có
 * thao tác thành công không ném lỗi mà đánh dấu `valid=false` kèm ghi chú trong ScenarioResult.
 */
export async function runScenario(
  env: PerfEnv,
  config: PerfConfig,
  scenario: ScenarioDefinition,
  options: { tag?: string } = {},
): Promise<ScenarioResult> {
  for (const concurrency of config.concurrency) assertConcurrencyFitsPool(env, concurrency);
  const customers = await ensureCustomers(env, config);
  const label = options.tag === undefined ? scenario.name : `${scenario.name} [${options.tag}]`;
  const invalid: string[] = [];
  const info: string[] = [];
  const levels = [];
  for (const concurrency of config.concurrency) {
    const repeats: RepeatResult[] = [];
    const ceiling = estimateMaxOps(concurrency, config.warmupSeconds + config.durationSeconds);
    for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
      const where = `kịch bản ${label}, mức ${concurrency}, lần lặp ${repeat}`;
      const previous = repeats[repeats.length - 1];
      const plan: ScenarioPlan = {
        concurrency,
        repeat,
        customers,
        maxOps:
          previous === undefined
            ? ceiling
            : observedMaxOps(
                {
                  ok: previous.ok,
                  errors:
                    previous.errors.deadlock + previous.errors.timeout + previous.errors.other,
                },
                config,
                concurrency,
                ceiling,
              ),
      };
      const outcome = await runRepeat(env, config, scenario, plan, where);
      repeats.push(outcome.result);
      invalid.push(...outcome.invalid);
      info.push(...outcome.info);
    }
    levels.push(buildLevelResult(concurrency, repeats));
  }
  return {
    name: scenario.name,
    description: scenario.description,
    levels,
    valid: invalid.length === 0,
    notes: [...invalid, ...info],
  };
}

/**
 * Gộp kết quả các kịch bản (và e2e nếu có) thành một PerfReport. Hợp lệ khi mọi kịch bản hợp lệ và e2e đạt bất biến.
 * Task 6 dùng lại hàm này để ghép các kịch bản thành báo cáo đầy đủ.
 */
export function collectReport(
  scenarios: ScenarioResult[],
  e2e: E2eResult | undefined,
  config: PerfConfig,
  machine: MachineInfo,
): PerfReport {
  const notes = scenarios.flatMap((s) => s.notes ?? []);
  const valid = scenarios.every((s) => s.valid !== false) && (e2e?.invariantsOk ?? true);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    machine,
    config: { ...config },
    scenarios,
    ...(e2e === undefined ? {} : { e2e }),
    valid,
    notes,
  };
}

/**
 * Dùng chung cho các tệp kịch bản: chạy `scenario`, dựng báo cáo một phần (kèm máy/phiên bản SQL Server), ghi vào config.out
 * rồi trả báo cáo. Tệp được ghi TRƯỚC khi test khẳng định hợp lệ để kết quả vô hiệu vẫn còn dấu vết.
 */
export async function runAndReport(
  env: PerfEnv,
  config: PerfConfig,
  scenario: ScenarioDefinition,
): Promise<PerfReport> {
  const result = await runScenario(env, config, scenario);
  const machine = describeRunMachine(config, await readSqlServerVersion(env.admin));
  const report = collectReport([result], undefined, config, machine);
  await writePartialReport(report, config, scenario.name);
  return report;
}

/** Phiên bản SQL Server (dòng đầu của @@VERSION), null nếu không đọc được. */
export async function readSqlServerVersion(admin: Kysely<unknown>): Promise<string | null> {
  try {
    const result = await sql<{ v: string }>`select @@version as v`.execute(admin);
    const first = result.rows[0]?.v.split(/\r?\n/)[0]?.trim();
    return first === undefined || first === '' ? null : first;
  } catch {
    return null;
  }
}

export function describeRunMachine(
  config: PerfConfig,
  sqlServerVersion: string | null,
): MachineInfo {
  return describeMachine({ label: config.machine, sqlServerVersion });
}

/** Tên tệp báo cáo: `<kịch bản>-<nhãn máy>`, ký tự ngoài [A-Za-z0-9._-] đổi thành '_'. */
export function reportFileName(scenario: string, machine: string): string {
  return `${scenario}-${machine}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Ghi báo cáo một phần của một kịch bản vào `config.out`; Task 6 gộp các tệp này. */
export async function writePartialReport(
  report: PerfReport,
  config: PerfConfig,
  scenario: string,
): Promise<{ json: string; markdown: string }> {
  return writeReport(report, config.out, reportFileName(scenario, config.machine));
}
