import { hostname } from 'node:os';

/** Cấu hình bộ đo hiệu năng, đọc từ biến môi trường PERF_*. */
export interface PerfConfig {
  concurrency: readonly number[];
  durationSeconds: number;
  warmupSeconds: number;
  repeats: number;
  customers: number;
  tenants: number;
  e2eOrders: number;
  e2eConcurrency: number;
  machine: string;
  out: string;
  scenarios: readonly string[] | null;
}

// Biến chưa đặt hoặc chỉ toàn khoảng trắng coi như không đặt (dùng mặc định).
function raw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

// Số nguyên dương an toàn; sai thì ném lỗi nêu tên biến.
function positiveInt(name: string, text: string): number {
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be a positive integer, got "${text}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${text}"`);
  }
  return value;
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const text = raw(env, name);
  return text === undefined ? fallback : positiveInt(name, text);
}

function intList(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: readonly number[],
): readonly number[] {
  const text = raw(env, name);
  if (text === undefined) return fallback;
  // Phần tử rỗng (vd "1,,4" hoặc ",") là lỗi, không bỏ qua im lặng.
  return text.split(',').map((part) => positiveInt(name, part.trim()));
}

/** Đọc và kiểm tra PERF_*; giá trị sai ném Error nêu tên biến. */
export function loadPerfConfig(env: NodeJS.ProcessEnv): PerfConfig {
  const scenarioText = raw(env, 'PERF_SCENARIOS');
  const scenarios =
    scenarioText === undefined
      ? null
      : scenarioText
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
  if (scenarios !== null && scenarios.length === 0) {
    throw new Error(`PERF_SCENARIOS must list at least one scenario name, got "${scenarioText}"`);
  }
  return {
    concurrency: intList(env, 'PERF_CONCURRENCY', [1, 4, 16, 64]),
    durationSeconds: intVar(env, 'PERF_DURATION_SECONDS', 20),
    warmupSeconds: intVar(env, 'PERF_WARMUP_SECONDS', 3),
    repeats: intVar(env, 'PERF_REPEATS', 3),
    customers: intVar(env, 'PERF_CUSTOMERS', 2000),
    tenants: intVar(env, 'PERF_TENANTS', 1),
    e2eOrders: intVar(env, 'PERF_E2E_ORDERS', 200),
    e2eConcurrency: intVar(env, 'PERF_E2E_CONCURRENCY', 16),
    machine: raw(env, 'PERF_MACHINE') ?? hostname(),
    out: raw(env, 'PERF_OUT') ?? 'tests/perf/.out',
    scenarios,
  };
}
