import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Tài nguyên tiêu thụ trong một lượt đo (khởi động + đo), để biết bộ sinh tải/CPU có phải là giới hạn hay không. */
export interface ResourceUsage {
  /** Độ dài khoảng theo dõi (s, đồng hồ thật). */
  wallSeconds: number;
  /** CPU của tiến trình Node (bộ sinh tải + use case + driver SQL), user + system, tính bằng giây CPU. */
  nodeCpuSeconds: number;
  /** nodeCpuSeconds / wallSeconds × 100: phần trăm của MỘT lõi (có thể > 100 nếu dùng nhiều luồng libuv). */
  nodeCpuPercent: number;
  /**
   * Độ trễ vòng lặp sự kiện của Node (ms): p50, p99 và lớn nhất, đã trừ chu kỳ lấy mẫu 10 ms (0 = timer chạy đúng hạn). Chu kỳ
   * 10 ms nên độ phân giải cỡ vài ms; timer của Windows (~1-15 ms) cũng góp vào.
   */
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  /**
   * CPU của container SQL Server testcontainers theo `docker stats` (phần trăm của MỘT lõi, như docker in ra), lấy mẫu định kỳ
   * trong khoảng theo dõi; null nếu không tìm được container hoặc docker lỗi (lý do ở `sqlCpuError`).
   */
  sqlCpuPercent: { mean: number; max: number; samples: number } | null;
  sqlCpuError?: string;
}

/** "123.45%" → 123.45; chuỗi lạ → null. */
export function parseCpuPercent(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Trung bình/lớn nhất của các mẫu; rỗng → null. */
export function summarizeSamples(
  samples: readonly number[],
): { mean: number; max: number; samples: number } | null {
  if (samples.length === 0) return null;
  const sum = samples.reduce((a, b) => a + b, 0);
  return { mean: sum / samples.length, max: Math.max(...samples), samples: samples.length };
}

/**
 * Chọn container SQL Server của testcontainers từ các dòng `<id> <tên>` (đã lọc theo nhãn org.testcontainers và image mssql).
 * Không bao giờ chọn container `billing-local-*` (stack dùng chung). Không đúng MỘT ứng viên → null (không đoán).
 */
export function pickSqlContainer(lines: readonly string[]): string | null {
  const candidates = lines
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) => parts.length >= 2 && parts[0] !== '' && !parts[1]!.startsWith('billing-local'),
    )
    .map((parts) => parts[0]!);
  return candidates.length === 1 ? candidates[0]! : null;
}

const SQL_IMAGE = 'mcr.microsoft.com/mssql/server';
const LOOP_RESOLUTION_MS = 10;

async function findSqlContainer(): Promise<string> {
  const { stdout } = await run(
    'docker',
    [
      'ps',
      '--filter',
      'label=org.testcontainers=true',
      '--format',
      '{{.ID}} {{.Names}} {{.Image}}',
    ],
    { timeout: 15_000, windowsHide: true },
  );
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.split(/\s+/)[2]?.startsWith(SQL_IMAGE) ?? false);
  const id = pickSqlContainer(lines);
  if (id === null) {
    throw new Error(
      `không xác định được đúng một container SQL Server testcontainers (${lines.length} ứng viên)`,
    );
  }
  return id;
}

let cachedContainer: Promise<string> | undefined;

/** Id container SQL Server của lượt chạy (tìm một lần, lỗi thì lần sau thử lại). */
function sqlContainer(): Promise<string> {
  cachedContainer ??= findSqlContainer();
  cachedContainer.catch(() => (cachedContainer = undefined));
  return cachedContainer;
}

async function sampleSqlCpu(id: string): Promise<number | null> {
  const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', id], {
    timeout: 15_000,
    windowsHide: true,
  });
  return parseCpuPercent(stdout);
}

export interface ResourceMonitorOptions {
  /** Khoảng giữa hai lần lấy mẫu docker stats (ms). Mặc định 5000. false = không lấy CPU của SQL. */
  sqlSampleIntervalMs?: number | false;
}

/**
 * Bắt đầu theo dõi: chụp process.cpuUsage(), bật monitorEventLoopDelay, và (nếu được) lấy mẫu CPU container SQL tuần tự mỗi
 * `sqlSampleIntervalMs`. Chi phí thấp: mỗi mẫu docker là một tiến trình con ngắn. `stop()` trả ResourceUsage, không bao giờ ném
 * vì lỗi docker (ghi vào sqlCpuError).
 */
export function startResourceMonitor(options: ResourceMonitorOptions = {}): {
  stop(): Promise<ResourceUsage>;
} {
  const interval = options.sqlSampleIntervalMs ?? 5000;
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();

  const samples: number[] = [];
  let sqlError: string | undefined;
  let running = true;
  let wake: (() => void) | undefined;
  const sampler =
    interval === false
      ? Promise.resolve()
      : (async () => {
          try {
            const id = await sqlContainer();
            while (running) {
              const value = await sampleSqlCpu(id);
              if (value !== null) samples.push(value);
              if (!running) break;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, interval);
                wake = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
            }
          } catch (error) {
            sqlError = error instanceof Error ? error.message : String(error);
          }
        })();

  return {
    async stop() {
      const wallSeconds = (performance.now() - startedAt) / 1000;
      const cpu = process.cpuUsage(cpuStart);
      loop.disable();
      running = false;
      wake?.();
      await sampler;
      const nodeCpuSeconds = (cpu.user + cpu.system) / 1e6;
      // Histogram ghi KHOẢNG giữa hai lần timer chạy (gồm cả chu kỳ lấy mẫu), nên trừ chu kỳ để còn phần trễ thật.
      const ms = (ns: number): number => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS);
      const usage: ResourceUsage = {
        wallSeconds,
        nodeCpuSeconds,
        nodeCpuPercent: wallSeconds > 0 ? (nodeCpuSeconds / wallSeconds) * 100 : 0,
        eventLoopDelayMs: {
          p50: ms(loop.percentile(50)),
          p99: ms(loop.percentile(99)),
          max: ms(loop.max),
        },
        sqlCpuPercent: interval === false ? null : summarizeSamples(samples),
      };
      if (interval === false) usage.sqlCpuError = 'tắt';
      else if (sqlError !== undefined) usage.sqlCpuError = sqlError;
      else if (samples.length === 0) usage.sqlCpuError = 'không có mẫu docker stats';
      return usage;
    },
  };
}

/** Một dòng ghi chú cho báo cáo. */
export function describeResources(usage: ResourceUsage): string {
  const f = (n: number): string => n.toFixed(1);
  const sql =
    usage.sqlCpuPercent === null
      ? `CPU SQL: n/a (${usage.sqlCpuError ?? 'không rõ'})`
      : `CPU container SQL TB ${f(usage.sqlCpuPercent.mean)}% / tối đa ${f(usage.sqlCpuPercent.max)}% một lõi (${usage.sqlCpuPercent.samples} mẫu docker stats)`;
  return `tài nguyên (khởi động + đo, ${f(usage.wallSeconds)} s): CPU Node ${f(usage.nodeCpuSeconds)} s (${f(usage.nodeCpuPercent)}% một lõi); trễ vòng lặp sự kiện p50 ${f(usage.eventLoopDelayMs.p50)} / p99 ${f(usage.eventLoopDelayMs.p99)} / tối đa ${f(usage.eventLoopDelayMs.max)} ms; ${sql}`;
}
