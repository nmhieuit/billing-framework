import { readFile } from 'node:fs/promises';

export type RuleName =
  | 'billing-dlq-not-empty'
  | 'billing-outbox-stuck'
  | 'billing-topups-stuck'
  | 'billing-ledger-integrity'
  | 'billing-reconciliation-stale-cases'
  | 'billing-reconciliation-missed'
  | 'billing-reconciliation-failed-run'
  | 'billing-service-silent';

export type Severity = 'critical' | 'high' | 'warning';

export interface CommonRuleParams {
  enabled: boolean;
  severity: Severity;
  intervalMinutes: number;
  windowMinutes: number;
}

interface Extras {
  'billing-dlq-not-empty': { minDepth: number };
  'billing-outbox-stuck': { thresholdSeconds: number };
  'billing-topups-stuck': { thresholdSeconds: number };
  'billing-ledger-integrity': { minOpenItems: number };
  'billing-reconciliation-stale-cases': { maxAgeHours: number };
  'billing-reconciliation-missed': { maxAgeHours: number };
  'billing-reconciliation-failed-run': Record<string, never>;
  'billing-service-silent': { silentMinutes: number; lookbackHours: number };
}

export interface Params {
  dashboard: { timeRange: string; refreshSeconds: number };
  rules: { [R in RuleName]: CommonRuleParams & Extras[R] };
}

export class ParamsError extends Error {
  readonly problems: string[];
  constructor(problems: string[], context?: string) {
    super([...(context ? [context] : []), ...problems].join('\n'));
    this.name = 'ParamsError';
    this.problems = problems;
  }
}

interface Range {
  min: number;
  max: number;
}
const SEVERITIES: readonly string[] = ['critical', 'high', 'warning'];
const TIME_RANGE = /^now-\d+[mhd]$/;

// Khoảng giá trị cho các khoá dùng chung của mọi rule.
const COMMON: Record<string, Range> = {
  intervalMinutes: { min: 1, max: 60 },
  windowMinutes: { min: 1, max: 1440 },
};
const DASHBOARD: Record<string, Range> = { refreshSeconds: { min: 0, max: 3600 } };

// Khoá riêng của từng rule và khoảng hợp lệ; thứ tự khoá quyết định thứ tự báo lỗi.
const SCHEMA: Record<RuleName, Record<string, Range>> = {
  'billing-dlq-not-empty': { minDepth: { min: 0, max: 1_000_000 } },
  'billing-outbox-stuck': { thresholdSeconds: { min: 1, max: 604_800 } },
  'billing-topups-stuck': { thresholdSeconds: { min: 1, max: 604_800 } },
  'billing-ledger-integrity': { minOpenItems: { min: 0, max: 1_000_000 } },
  'billing-reconciliation-stale-cases': { maxAgeHours: { min: 1, max: 720 } },
  'billing-reconciliation-missed': { maxAgeHours: { min: 1, max: 720 } },
  'billing-reconciliation-failed-run': {},
  'billing-service-silent': {
    silentMinutes: { min: 1, max: 1440 },
    lookbackHours: { min: 1, max: 168 },
  },
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Gộp sâu object thuần; mảng và giá trị đơn của local thay thế hoàn toàn.
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const merged = Object.hasOwn(base, k) ? deepMerge(base[k], v) : v;
    // defineProperty để khoá "__proto__" luôn là thuộc tính riêng, không đổi prototype.
    Object.defineProperty(out, k, {
      value: merged,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function checkRange(value: unknown, range: Range, path: string, problems: string[]): void {
  if (typeof value !== 'number' || !Number.isInteger(value))
    problems.push(`${path}: must be an integer`);
  else if (value < range.min || value > range.max)
    problems.push(`${path}: must be between ${range.min} and ${range.max}`);
}

// Kiểm tra một object theo bảng khoá; khoá lạ bị từ chối kèm đường dẫn đầy đủ.
function checkSection(
  value: unknown,
  path: string,
  problems: string[],
  checks: Record<string, (v: unknown, p: string) => void>,
): void {
  if (!isObj(value)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  for (const k of Object.keys(value))
    if (!Object.hasOwn(checks, k)) problems.push(`${path}.${k}: unknown key`);
  for (const [k, check] of Object.entries(checks)) {
    if (Object.hasOwn(value, k)) check(value[k], `${path}.${k}`);
    else problems.push(`${path}.${k}: is required`);
  }
}

export function mergeParams(defaults: unknown, local: unknown): Params {
  const merged = deepMerge(defaults, local);
  const problems: string[] = [];
  const range = (r: Range) => (v: unknown, p: string) => checkRange(v, r, p, problems);
  const rangeChecks = (table: Record<string, Range>) =>
    Object.fromEntries(Object.entries(table).map(([k, r]) => [k, range(r)]));

  checkSection(merged, 'params', problems, {
    dashboard: (v, p) =>
      checkSection(v, p, problems, {
        timeRange: (t, tp) => {
          if (typeof t !== 'string' || !TIME_RANGE.test(t))
            problems.push(`${tp}: must match now-<n>[mhd]`);
        },
        ...rangeChecks(DASHBOARD),
      }),
    rules: (v, p) =>
      checkSection(
        v,
        p,
        problems,
        Object.fromEntries(
          (Object.keys(SCHEMA) as RuleName[]).map((name) => [
            name,
            (r: unknown, rp: string) =>
              checkSection(r, rp, problems, {
                enabled: (e, ep) => {
                  if (typeof e !== 'boolean') problems.push(`${ep}: must be boolean`);
                },
                severity: (s, sp) => {
                  if (typeof s !== 'string' || !SEVERITIES.includes(s))
                    problems.push(`${sp}: must be one of ${SEVERITIES.join(', ')}`);
                },
                ...rangeChecks(COMMON),
                ...rangeChecks(SCHEMA[name]),
              }),
          ]),
        ),
      ),
  });
  // Ràng buộc chéo chỉ kiểm khi các trường liên quan đã hợp lệ (lỗi kiểu/khoảng đã được báo ở trên).
  if (problems.length === 0) {
    const rules = (merged as Params).rules;
    for (const name of Object.keys(SCHEMA) as RuleName[]) {
      const r = rules[name];
      if (r.windowMinutes < r.intervalMinutes) {
        problems.push(
          `params.rules.${name}.windowMinutes: must be >= intervalMinutes (${r.intervalMinutes}), otherwise runs can miss data`,
        );
      }
    }
    const silent = rules['billing-service-silent'];
    if (silent.silentMinutes >= silent.lookbackHours * 60) {
      problems.push(
        `params.rules.billing-service-silent.silentMinutes: must be less than lookbackHours * 60 (${silent.lookbackHours * 60}), otherwise the rule can never fire`,
      );
    }
  }
  if (problems.length > 0) {
    // Bỏ tiền tố "params." cho gọn; thứ tự theo bảng nên ổn định.
    throw new ParamsError(problems.map((m) => m.replace(/^params\./, '').replace(/^params: /, '')));
  }
  return merged as Params;
}

function withContext<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ParamsError)
      throw new ParamsError(e.problems, `Invalid parameters (${file}):`);
    throw e;
  }
}

async function readJson(path: string, optional: boolean): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ParamsError([`${path}: cannot read file (${(e as Error).message})`]);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isObj(parsed)) throw new SyntaxError('top-level value must be a JSON object');
    return parsed;
  } catch (e) {
    throw new ParamsError([`${path}: invalid JSON (${(e as Error).message})`]);
  }
}

export async function loadParams(options: {
  defaultsPath: string;
  localPath?: string;
}): Promise<Params> {
  const defaults = await readJson(options.defaultsPath, false);
  const local = options.localPath ? await readJson(options.localPath, true) : {};
  // Kiểm tra riêng defaults để phân biệt lỗi file defaults với lỗi file local.
  withContext(options.defaultsPath, () => mergeParams(defaults, {}));
  return withContext(options.localPath ?? options.defaultsPath, () => mergeParams(defaults, local));
}
