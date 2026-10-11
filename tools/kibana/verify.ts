import type { KibanaClient } from './client.js';
import { KibanaError } from './client.js';
import { buildDashboard, dashboardQueries } from './dashboard.js';
import type { Params } from './params.js';
import { buildRules } from './rules.js';

export interface CheckResult {
  ok: boolean;
  message: string;
}

export interface VerifyOptions {
  params: Params;
  client: KibanaClient;
  esUrl: string;
  esFetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Tên rule cần có alert đang active (tuỳ chọn). */
  expectAlert?: string;
  timeoutMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

const pass = (message: string): CheckResult => ({ ok: true, message });
const fail = (message: string): CheckResult => ({ ok: false, message });

/** (a) Mỗi rule mong muốn tồn tại, `enabled` khớp tham số và lần chạy gần nhất không lỗi. */
export async function checkRules(client: KibanaClient, params: Params): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const rule of buildRules(params)) {
    const existing = await client.getRule(rule.id);
    if (!existing) {
      results.push(fail(`rule ${rule.name} is missing in Kibana (run kibana:apply)`));
      continue;
    }
    if (existing.enabled !== rule.enabled) {
      results.push(
        fail(`rule ${rule.name} has enabled=${existing.enabled} but params say ${rule.enabled}`),
      );
      continue;
    }
    const status = existing.execution_status?.status;
    if (status === 'error') {
      const reason = existing.execution_status?.error?.message ?? 'no message';
      results.push(fail(`rule ${rule.name} execution status is error: ${reason}`));
      continue;
    }
    results.push(
      pass(
        `rule ${rule.name} exists, enabled=${existing.enabled}, status ${status ?? 'not run yet'}`,
      ),
    );
  }
  return results;
}

/** (b) Saved object dashboard tồn tại. */
export async function checkDashboard(client: KibanaClient, params: Params): Promise<CheckResult> {
  const id = buildDashboard(params).find((o) => o.type === 'dashboard')!.id;
  return (await client.dashboardExists(id))
    ? pass(`dashboard ${id} exists`)
    : fail(`dashboard ${id} is missing in Kibana (run kibana:apply)`);
}

async function runQuery(
  options: Pick<VerifyOptions, 'esUrl' | 'esFetch' | 'now'>,
  label: string,
  esql: string,
  withRange: boolean,
): Promise<CheckResult> {
  const body: { query: string; params?: unknown[] } = { query: esql };
  if (withRange) {
    const end = options.now();
    body.params = [
      { _tstart: new Date(end - 3_600_000).toISOString() },
      { _tend: new Date(end).toISOString() },
    ];
  }
  let res: Response;
  try {
    res = await options.esFetch(`${options.esUrl.replace(/\/+$/, '')}/_query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return fail(`query ${label}: Elasticsearch unreachable (${(e as Error).message})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let reason = text.trim();
    try {
      const parsed = JSON.parse(text) as { error?: { reason?: string } };
      reason = parsed.error?.reason ?? reason;
    } catch {
      // Không phải JSON: giữ nguyên văn bản.
    }
    return fail(`query ${label}: HTTP ${res.status} ${reason}`);
  }
  return pass(`query ${label} runs`);
}

/** (c) Mọi câu ES|QL của panel và rule (lấy từ generator) chạy được trên Elasticsearch. */
export async function checkQueries(
  options: Pick<VerifyOptions, 'esUrl' | 'esFetch' | 'now' | 'params'>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const q of dashboardQueries(buildDashboard(options.params))) {
    results.push(await runQuery(options, `panel "${q.title}"`, q.esql, true));
  }
  for (const r of buildRules(options.params)) {
    results.push(await runQuery(options, `rule ${r.name}`, r.esql, false));
  }
  return results;
}

/** (d) Chờ rule có alert active (`last_run.alerts_count.active > 0`) hoặc hết thời gian. */
export async function waitForActiveAlert(
  options: Pick<VerifyOptions, 'client' | 'params' | 'timeoutMs' | 'pollMs' | 'sleep' | 'now'>,
  ruleName: string,
): Promise<CheckResult> {
  const rule = buildRules(options.params).find((r) => r.name === ruleName);
  if (!rule) return fail(`--expect-alert: unknown rule ${ruleName}`);
  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    const existing = await options.client.getRule(rule.id);
    const active = existing?.last_run?.alerts_count?.active ?? 0;
    if (active > 0) return pass(`rule ${ruleName} has ${active} active alert(s)`);
    if (options.now() >= deadline) {
      return fail(
        `rule ${ruleName} has no active alert within ${Math.round(options.timeoutMs / 1000)} s`,
      );
    }
    await options.sleep(options.pollMs);
  }
}

/** Số alert đã recovered quá nhanh (trong cửa sổ kiểm tra) từ mức này trở lên được coi là "nhấp nháy". */
const FLAP_MIN_SHORT_LIVED = 2;
/** Cửa sổ nhìn lại, tính theo số lần chạy của rule. */
const FLAP_LOOKBACK_RUNS = 10;
const ALERTS_INDEX = '.alerts-stack.alerts-default';

/**
 * (e) Với mỗi rule đang có alert active: không được có >= 2 alert đã recovered mà sống ngắn hơn 2 lần chu kỳ chạy
 * trong 10 lần chạy gần đây. Đó là dấu hiệu id instance không ổn định (cột giá trị lọt vào KEEP) khiến mỗi lần chạy
 * lại sinh alert mới và đóng alert cũ. Alert chỉ nháy một lần (điều kiện thật sự dao động) không bị tính là lỗi.
 */
export async function checkFlapping(
  options: Pick<VerifyOptions, 'client' | 'params' | 'esUrl' | 'esFetch'>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const rule of buildRules(options.params)) {
    const existing = await options.client.getRule(rule.id);
    const active = existing?.last_run?.alerts_count?.active ?? 0;
    if (active <= 0) continue;
    const label = `rule ${rule.name} alert ids are stable`;
    const body = {
      size: 0,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            { term: { 'kibana.alert.rule.uuid': rule.id } },
            { term: { 'kibana.alert.status': 'recovered' } },
            {
              range: {
                'kibana.alert.end': { gte: `now-${FLAP_LOOKBACK_RUNS * rule.intervalMinutes}m` },
              },
            },
            {
              range: { 'kibana.alert.duration.us': { lt: 2 * rule.intervalMinutes * 60_000_000 } },
            },
          ],
        },
      },
    };
    let res: Response;
    try {
      res = await options.esFetch(`${options.esUrl.replace(/\/+$/, '')}/${ALERTS_INDEX}/_search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      results.push(fail(`${label}: Elasticsearch unreachable (${(e as Error).message})`));
      continue;
    }
    if (!res.ok) {
      results.push(fail(`${label}: cannot read ${ALERTS_INDEX} (HTTP ${res.status})`));
      continue;
    }
    const json = (await res.json()) as { hits?: { total?: { value?: number } } };
    const shortLived = json.hits?.total?.value ?? 0;
    results.push(
      shortLived >= FLAP_MIN_SHORT_LIVED
        ? fail(
            `rule ${rule.name} is flapping: ${shortLived} alerts recovered within ${2 * rule.intervalMinutes} min of starting in the last ${FLAP_LOOKBACK_RUNS * rule.intervalMinutes} min while ${active} alert(s) are active (alert instance id must contain only the identity columns ${rule.identityColumns.join(', ')})`,
          )
        : pass(
            `${label} (${shortLived} short-lived recovered in the last ${FLAP_LOOKBACK_RUNS * rule.intervalMinutes} min)`,
          ),
    );
  }
  return results;
}

/** Chạy mọi kiểm tra, in mỗi kiểm tra một dòng PASS/FAIL; `true` chỉ khi tất cả đều đạt. */
export async function runVerify(options: VerifyOptions): Promise<boolean> {
  const results: CheckResult[] = [];
  try {
    results.push(...(await checkRules(options.client, options.params)));
    results.push(await checkDashboard(options.client, options.params));
    results.push(...(await checkFlapping(options)));
  } catch (e) {
    if (!(e instanceof KibanaError)) throw e;
    results.push(fail(`kibana: ${e.message}`));
  }
  results.push(...(await checkQueries(options)));
  if (options.expectAlert !== undefined) {
    try {
      results.push(await waitForActiveAlert(options, options.expectAlert));
    } catch (e) {
      if (!(e instanceof KibanaError)) throw e;
      results.push(fail(`kibana: ${e.message}`));
    }
  }
  for (const r of results) options.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.message}`);
  return results.every((r) => r.ok);
}
