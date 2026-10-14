import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LatencySummary } from './histogram.js';
import type { MachineInfo } from './machine.js';
import { median, range } from './stats.js';

export interface BlockedSummary {
  waitType: string;
  statement: string;
  count: number;
  /** Tối đa vài wait_resource phổ biến nhất của nhóm (tùy chọn, tương thích ngược); renderer Markdown hiển thị ở cột cuối. */
  resources?: Array<{ resource: string; count: number }>;
}

export interface RepeatResult {
  throughputPerSec: number;
  ok: number;
  errors: { deadlock: number; timeout: number; other: number };
  latency: LatencySummary;
  waits: Record<string, { waitMs: number; count: number }>;
  blocked: BlockedSummary[];
}

export interface LevelResult {
  concurrency: number;
  repeats: RepeatResult[];
  medianThroughputPerSec: number;
  throughputRange: { min: number; max: number };
  medianP95Ms: number;
  medianP99Ms: number;
}

export interface ScenarioResult {
  name: string;
  description: string;
  levels: LevelResult[];
  /** false = có lượt đo vô hiệu (vd không có thao tác thành công); thiếu = coi là hợp lệ. collectReport gộp vào PerfReport.valid. */
  valid?: boolean;
  /** Ghi chú về các lượt vô hiệu (nêu kịch bản/mức/lần lặp). */
  notes?: string[];
}

export interface E2eResult {
  orders: number;
  concurrency: number;
  throughputPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  invariantsOk: boolean;
}

/**
 * Báo cáo đo. Lưu ý JSON: JSON.stringify biến NaN/Infinity thành null (vd độ trễ của lượt không có thao tác thành công), nên
 * báo cáo đọc lại từ tệp có thể mang null ở chỗ kiểu khai báo là number. renderMarkdown in "n/a" cho cả NaN lẫn null,
 * và buildLevelResult bỏ qua giá trị không hữu hạn khi lấy trung vị (toàn bộ không hữu hạn → NaN).
 */
export interface PerfReport {
  schemaVersion: 1;
  createdAt: string;
  machine: MachineInfo;
  config: Record<string, unknown>;
  scenarios: ScenarioResult[];
  e2e?: E2eResult;
  valid: boolean;
  notes: string[];
}

/** Gộp các lần lặp của một mức đồng thời: trung vị thông lượng/p95/p99 và khoảng min–max thông lượng. */
export function buildLevelResult(concurrency: number, repeats: RepeatResult[]): LevelResult {
  // Lượt không có thao tác thành công cho p95/p99 = NaN; NaN trong comparator của sort làm trung vị vô nghĩa nên bỏ ra trước.
  const finite = (values: number[]): number[] => values.filter((v) => Number.isFinite(v));
  const throughputs = finite(repeats.map((r) => r.throughputPerSec));
  return {
    concurrency,
    repeats,
    medianThroughputPerSec: median(throughputs),
    throughputRange: range(throughputs),
    medianP95Ms: median(finite(repeats.map((r) => r.latency.p95))),
    medianP99Ms: median(finite(repeats.map((r) => r.latency.p99))),
  };
}

// NaN, Infinity và null (NaN sau vòng JSON) đều in "n/a" thay vì "NaN".
const f1 = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : 'n/a';

// Dấu | trong ô bảng Markdown phải được escape; xuống dòng đổi thành khoảng trắng.
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

function totalErrors(level: LevelResult): number {
  return level.repeats.reduce(
    (acc, r) => acc + r.errors.deadlock + r.errors.timeout + r.errors.other,
    0,
  );
}

/** Số câu lệnh tối đa hiển thị cho mỗi kịch bản ở mục chờ khóa. */
const BLOCKED_TOP_N = 10;
const RESOURCES_TOP_N = 3;

// Gộp các câu lệnh bị chặn của MỘT kịch bản qua mọi mức/lần lặp, nhiều nhất lên đầu (hòa thì theo thứ tự xuất hiện).
// Tài nguyên của cùng một nhóm được cộng dồn rồi giữ top vài mục.
function aggregateBlocked(scenario: ScenarioResult): BlockedSummary[] {
  const byKey = new Map<string, BlockedSummary>();
  const resources = new Map<string, Map<string, number>>();
  for (const l of scenario.levels) {
    for (const r of l.repeats) {
      for (const b of r.blocked) {
        const key = `${b.waitType}\u0000${b.statement}`;
        const cur = byKey.get(key);
        if (cur) cur.count += b.count;
        else byKey.set(key, { waitType: b.waitType, statement: b.statement, count: b.count });
        if (b.resources) {
          const per = resources.get(key) ?? new Map<string, number>();
          for (const res of b.resources) {
            per.set(res.resource, (per.get(res.resource) ?? 0) + res.count);
          }
          resources.set(key, per);
        }
      }
    }
  }
  for (const [key, group] of byKey) {
    const per = resources.get(key);
    if (per === undefined) continue;
    group.resources = [...per]
      .map(([resource, count]) => ({ resource, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, RESOURCES_TOP_N);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

const resourcesCell = (b: BlockedSummary): string =>
  b.resources && b.resources.length > 0
    ? cell(b.resources.map((r) => `${r.resource} (${r.count})`).join('; '))
    : '-';

/** Dựng báo cáo Markdown (nhãn tiếng Việt). Xác định: cùng đầu vào cho cùng đầu ra. */
export function renderMarkdown(report: PerfReport): string {
  const m = report.machine;
  const out: string[] = [
    '# Báo cáo hiệu năng',
    '',
    `- Thời điểm: ${report.createdAt}`,
    `- Máy: ${m.label} (${m.cpus} CPU, ${m.memoryGb} GB RAM, Node ${m.node}, ${m.os})`,
    `- SQL Server: ${m.sqlServerVersion ?? 'không rõ'}`,
    `- Git: ${m.gitSha ?? 'không rõ'}`,
    `- Hợp lệ: ${report.valid ? 'có' : 'không'}`,
    '',
  ];

  for (const s of report.scenarios) {
    out.push(`## Kịch bản: ${s.name}`, '', s.description, '');
    out.push(
      '| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const l of s.levels) {
      out.push(
        `| ${l.concurrency} | ${f1(l.medianThroughputPerSec)} | ${f1(l.throughputRange.min)}–${f1(l.throughputRange.max)} | ${f1(l.medianP95Ms)} | ${f1(l.medianP99Ms)} | ${totalErrors(l)} |`,
      );
    }
    out.push('');
  }

  out.push('## Chờ khóa nổi bật', '');
  if (report.scenarios.length === 0) out.push('Không ghi nhận chờ khóa.', '');
  for (const s of report.scenarios) {
    out.push(`### ${s.name}`, '');
    const blocked = aggregateBlocked(s);
    if (blocked.length === 0) {
      out.push('Không ghi nhận chờ khóa.', '');
      continue;
    }
    out.push(
      '| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |',
      '| --- | --- | --- | --- |',
    );
    for (const b of blocked.slice(0, BLOCKED_TOP_N)) {
      out.push(`| ${cell(b.waitType)} | ${cell(b.statement)} | ${b.count} | ${resourcesCell(b)} |`);
    }
    if (blocked.length > BLOCKED_TOP_N) {
      out.push('', `Chỉ hiển thị ${BLOCKED_TOP_N}/${blocked.length} câu lệnh nhiều nhất.`);
    }
    out.push('');
  }

  if (report.e2e) {
    const e = report.e2e;
    out.push(
      '## End-to-end',
      '',
      `- Số đơn: ${e.orders}`,
      `- Mức đồng thời: ${e.concurrency}`,
      `- Thông lượng/giây: ${f1(e.throughputPerSec)}`,
      `- p50 / p95 / p99 (ms): ${f1(e.p50Ms)} / ${f1(e.p95Ms)} / ${f1(e.p99Ms)}`,
      `- Bất biến: ${e.invariantsOk ? 'đạt' : 'không đạt'}`,
      '',
    );
  }

  if (report.notes.length > 0) {
    out.push('## Ghi chú', '', ...report.notes.map((n) => `- ${n}`), '');
  }

  return out.join('\n');
}

// Tên tệp chỉ gồm chữ, số, '.', '_', '-' và bắt đầu bằng chữ/số: chặn dấu phân cách đường dẫn và '..'.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ghi <name>.json và <name>.md vào dir (tạo thư mục đệ quy). Ném lỗi nếu name không an toàn. */
export async function writeReport(
  report: PerfReport,
  dir: string,
  name: string,
): Promise<{ json: string; markdown: string }> {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new Error(`Invalid report name "${name}": use letters, digits, '.', '_', '-' only`);
  }
  await mkdir(dir, { recursive: true });
  const json = join(dir, `${name}.json`);
  const markdown = join(dir, `${name}.md`);
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdown, renderMarkdown(report), 'utf8');
  return { json, markdown };
}
