import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LatencySummary } from './histogram.js';
import type { MachineInfo } from './machine.js';
import { median, range } from './stats.js';

export interface BlockedSummary {
  waitType: string;
  statement: string;
  count: number;
  /** Tối đa vài wait_resource phổ biến nhất (tùy chọn, tương thích ngược; renderer Markdown chưa dùng). */
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
  const throughputs = repeats.map((r) => r.throughputPerSec);
  return {
    concurrency,
    repeats,
    medianThroughputPerSec: median(throughputs),
    throughputRange: range(throughputs),
    medianP95Ms: median(repeats.map((r) => r.latency.p95)),
    medianP99Ms: median(repeats.map((r) => r.latency.p99)),
  };
}

const f1 = (n: number): string => n.toFixed(1);

// Dấu | trong ô bảng Markdown phải được escape; xuống dòng đổi thành khoảng trắng.
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

function totalErrors(level: LevelResult): number {
  return level.repeats.reduce(
    (acc, r) => acc + r.errors.deadlock + r.errors.timeout + r.errors.other,
    0,
  );
}

// Gộp các câu lệnh bị chặn qua mọi kịch bản/mức/lần lặp, nhiều nhất lên đầu (hòa thì theo thứ tự xuất hiện).
function aggregateBlocked(report: PerfReport): BlockedSummary[] {
  const byKey = new Map<string, BlockedSummary>();
  for (const s of report.scenarios) {
    for (const l of s.levels) {
      for (const r of l.repeats) {
        for (const b of r.blocked) {
          const key = `${b.waitType}\u0000${b.statement}`;
          const cur = byKey.get(key);
          if (cur) cur.count += b.count;
          else byKey.set(key, { ...b });
        }
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

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
  const blocked = aggregateBlocked(report);
  if (blocked.length === 0) {
    out.push('Không ghi nhận chờ khóa.', '');
  } else {
    out.push('| Loại chờ | Câu lệnh | Số lần |', '| --- | --- | --- |');
    for (const b of blocked) {
      out.push(`| ${cell(b.waitType)} | ${cell(b.statement)} | ${b.count} |`);
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
