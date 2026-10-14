import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLevelResult,
  renderMarkdown,
  writeReport,
  type PerfReport,
  type RepeatResult,
} from './report.js';

function latency(p95: number, p99: number) {
  return { count: 10, mean: 1, p50: 1, p95, p99, max: p99 };
}

function repeat(throughput: number, p95: number, p99: number, deadlock = 0): RepeatResult {
  return {
    throughputPerSec: throughput,
    ok: 100,
    errors: { deadlock, timeout: 0, other: 0 },
    latency: latency(p95, p99),
    waits: {},
    blocked: [],
  };
}

describe('buildLevelResult', () => {
  it('lấy trung vị thông lượng, min/max, trung vị p95/p99 qua các lần lặp', () => {
    const level = buildLevelResult(8, [
      repeat(100, 10, 20),
      repeat(900, 90, 500),
      repeat(200, 20, 40),
    ]);
    // Dữ liệu lệch (có ngoại lai) để trung vị khác trung bình.
    expect(level.concurrency).toBe(8);
    expect(level.medianThroughputPerSec).toBe(200);
    expect(level.throughputRange).toEqual({ min: 100, max: 900 });
    expect(level.medianP95Ms).toBe(20);
    expect(level.medianP99Ms).toBe(40);
    expect(level.repeats).toHaveLength(3);
  });
});

const sample: PerfReport = {
  schemaVersion: 1,
  createdAt: '2026-10-14T00:00:00.000Z',
  machine: {
    label: 'laptop-a',
    cpus: 8,
    memoryGb: 16,
    node: 'v22.0.0',
    os: 'Windows_NT 10.0 x64',
    sqlServerVersion: null,
    gitSha: null,
  },
  config: { repeats: 2 },
  scenarios: [
    {
      name: 'merchant-hotspot',
      description: 'Ghi dồn vào một merchant',
      levels: [
        buildLevelResult(1, [repeat(100, 5, 9), repeat(120, 6, 10)]),
        buildLevelResult(8, [
          {
            ...repeat(400.25, 12.5, 30, 2),
            blocked: [{ waitType: 'LCK_M_U', statement: 'UPDATE a | b', count: 7 }],
          },
          repeat(380, 14, 33),
        ]),
      ],
    },
  ],
  e2e: {
    orders: 50,
    concurrency: 4,
    throughputPerSec: 12.34,
    p50Ms: 80,
    p95Ms: 120,
    p99Ms: 150,
    invariantsOk: true,
  },
  valid: true,
  notes: ['chạy thử'],
};

// Bản mong đợi viết tay (không dùng snapshot tự sinh).
const expectedMarkdown = `# Báo cáo hiệu năng

- Thời điểm: 2026-10-14T00:00:00.000Z
- Máy: laptop-a (8 CPU, 16 GB RAM, Node v22.0.0, Windows_NT 10.0 x64)
- SQL Server: không rõ
- Git: không rõ
- Hợp lệ: có

## Kịch bản: merchant-hotspot

Ghi dồn vào một merchant

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 110.0 | 100.0–120.0 | 5.5 | 9.5 | 0 |
| 8 | 390.1 | 380.0–400.3 | 13.3 | 31.5 | 2 |

## Chờ khóa nổi bật

### merchant-hotspot

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | UPDATE a \\| b | 7 | - |

## End-to-end

- Số đơn: 50
- Mức đồng thời: 4
- Thông lượng/giây: 12.3
- p50 / p95 / p99 (ms): 80.0 / 120.0 / 150.0
- Bất biến: đạt

## Ghi chú

- chạy thử
`;

describe('renderMarkdown', () => {
  it('khớp chính xác bản mong đợi viết tay', () => {
    expect(renderMarkdown(sample)).toBe(expectedMarkdown);
  });

  it('gộp chờ khóa giống nhau qua các lần lặp và xếp nhiều nhất lên đầu', () => {
    const blk = (waitType: string, statement: string, count: number) => ({
      waitType,
      statement,
      count,
    });
    const md = renderMarkdown({
      ...sample,
      scenarios: [
        {
          name: 's',
          description: 'd',
          levels: [
            buildLevelResult(2, [
              {
                ...repeat(1, 2, 3),
                blocked: [blk('LCK_M_U', 'few', 2), blk('LCK_M_X', 'many', 5)],
              },
              { ...repeat(1, 2, 3), blocked: [blk('LCK_M_U', 'few', 4)] },
            ]),
          ],
        },
      ],
    });
    expect(md).toContain(
      '| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |\n| --- | --- | --- | --- |\n| LCK_M_U | few | 6 | - |\n| LCK_M_X | many | 5 | - |\n',
    );
  });

  it('mục chờ khóa chia theo kịch bản, không trộn câu lệnh giữa các kịch bản', () => {
    const blk = (statement: string, count: number) => ({
      waitType: 'LCK_M_U',
      statement,
      count,
    });
    const scenario = (name: string, blocked: ReturnType<typeof blk>[]) => ({
      name,
      description: 'd',
      levels: [buildLevelResult(2, [{ ...repeat(1, 2, 3), blocked }])],
    });
    const md = renderMarkdown({
      ...sample,
      scenarios: [scenario('alpha', [blk('stmt-a', 3)]), scenario('beta', [blk('stmt-b', 9)])],
    });
    expect(md).toContain(
      '## Chờ khóa nổi bật\n\n### alpha\n\n| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |\n| --- | --- | --- | --- |\n| LCK_M_U | stmt-a | 3 | - |\n\n### beta\n\n| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |\n| --- | --- | --- | --- |\n| LCK_M_U | stmt-b | 9 | - |\n',
    );
    const alpha = md.slice(md.indexOf('### alpha'), md.indexOf('### beta'));
    expect(alpha).not.toContain('stmt-b');
  });

  it('giới hạn 10 câu lệnh mỗi kịch bản và nói rõ phần bị cắt', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      waitType: 'LCK_M_U',
      statement: `stmt-${String(i).padStart(2, '0')}`,
      count: 100 - i,
    }));
    const md = renderMarkdown({
      ...sample,
      scenarios: [
        {
          name: 's',
          description: 'd',
          levels: [buildLevelResult(2, [{ ...repeat(1, 2, 3), blocked: many }])],
        },
      ],
    });
    expect(md).toContain('stmt-09');
    expect(md).not.toContain('stmt-10');
    expect(md).toContain('Chỉ hiển thị 10/12 câu lệnh nhiều nhất.');
  });

  it('hiển thị wait_resource hàng đầu của nhóm, cộng dồn qua các lần lặp', () => {
    const withResources = (resources: Array<{ resource: string; count: number }>) => ({
      ...repeat(1, 2, 3),
      blocked: [{ waitType: 'LCK_M_U', statement: 'upd', count: 5, resources }],
    });
    const md = renderMarkdown({
      ...sample,
      scenarios: [
        {
          name: 's',
          description: 'd',
          levels: [
            buildLevelResult(2, [
              withResources([
                { resource: 'KEY: 1', count: 3 },
                { resource: 'KEY: 2', count: 1 },
              ]),
              withResources([
                { resource: 'KEY: 2', count: 4 },
                { resource: 'KEY: 3', count: 1 },
                { resource: 'KEY: 4', count: 1 },
              ]),
            ]),
          ],
        },
      ],
    });
    // KEY: 2 = 5, KEY: 1 = 3, rồi KEY: 3 (hòa với KEY: 4, giữ thứ tự xuất hiện); chỉ giữ top 3.
    expect(md).toContain('| LCK_M_U | upd | 10 | KEY: 2 (5); KEY: 1 (3); KEY: 3 (1) |');
  });

  it('lượt không có mẫu (NaN) in n/a, cả khi đã qua vòng JSON (NaN thành null)', () => {
    const empty: RepeatResult = {
      throughputPerSec: 0,
      ok: 0,
      errors: { deadlock: 0, timeout: 0, other: 3 },
      latency: {
        count: 0,
        mean: Number.NaN,
        p50: Number.NaN,
        p95: Number.NaN,
        p99: Number.NaN,
        max: Number.NaN,
      },
      waits: {},
      blocked: [],
    };
    const level = buildLevelResult(4, [empty]);
    expect(level.medianP95Ms).toBeNaN();
    const report: PerfReport = {
      ...sample,
      scenarios: [{ name: 's', description: 'd', levels: [level] }],
    };
    const row = '| 4 | 0.0 | 0.0–0.0 | n/a | n/a | 3 |';
    expect(renderMarkdown(report)).toContain(row);
    expect(renderMarkdown(report)).not.toContain('NaN');
    const roundTrip = JSON.parse(JSON.stringify(report)) as PerfReport;
    expect(roundTrip.scenarios[0]?.levels[0]?.medianP95Ms).toBeNull();
    expect(renderMarkdown(roundTrip)).toContain(row);
    expect(renderMarkdown(roundTrip)).not.toContain('null');
  });

  it('trung vị bỏ qua lượt NaN thay vì bị phá bởi nó', () => {
    const empty = { ...repeat(0, 0, 0), latency: { ...latency(0, 0), p95: NaN, p99: NaN } };
    const level = buildLevelResult(2, [repeat(10, 5, 8), empty, repeat(30, 7, 9)]);
    expect(level.medianP95Ms).toBe(6);
    expect(level.medianP99Ms).toBe(8.5);
  });

  it('báo cáo không hợp lệ, không có e2e/chờ khóa/ghi chú', () => {
    const withoutE2e: PerfReport = { ...sample };
    delete withoutE2e.e2e;
    const md = renderMarkdown({
      ...withoutE2e,
      valid: false,
      notes: [],
      scenarios: [
        { name: 's', description: 'd', levels: [buildLevelResult(2, [repeat(1, 2, 3)])] },
      ],
    });
    expect(md).toContain('- Hợp lệ: không');
    expect(md).toContain('| 2 | 1.0 | 1.0–1.0 | 2.0 | 3.0 | 0 |');
    expect(md).toContain('## Chờ khóa nổi bật\n\n### s\n\nKhông ghi nhận chờ khóa.\n');
    expect(md).not.toContain('## End-to-end');
    expect(md).not.toContain('## Ghi chú');
  });
});

describe('writeReport', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('tạo thư mục lồng nhau, ghi .json (round-trip) và .md', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perf-report-'));
    const out = join(dir, 'a', 'b');
    const { json, markdown } = await writeReport(sample, out, 'run-1');
    expect(json).toBe(join(out, 'run-1.json'));
    expect(markdown).toBe(join(out, 'run-1.md'));
    const parsed = JSON.parse(await readFile(json, 'utf8')) as PerfReport;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed).toEqual(sample);
    expect(await readFile(markdown, 'utf8')).toBe(expectedMarkdown);
    expect((await stat(json)).isFile()).toBe(true);
  });

  it.each(['', '../x', 'a/b', 'a\\b', '..', '.', 'C:x', 'a b', '.hidden'])(
    'tên không hợp lệ %j bị từ chối',
    async (name) => {
      dir = await mkdtemp(join(tmpdir(), 'perf-report-'));
      await expect(writeReport(sample, dir, name)).rejects.toThrow();
    },
  );
});
