import { sql, type Kysely } from 'kysely';

export interface WaitSnapshot {
  at: number;
  /** Chỉ các wait_type LIKE 'LCK_M_%'. */
  waits: Record<string, { waitMs: number; count: number }>;
}

// tedious trả bigint dưới dạng chuỗi nên luôn ép qua Number.
export async function snapshotWaits(admin: Kysely<unknown>): Promise<WaitSnapshot> {
  const result = await sql<{
    wait_type: string;
    wait_time_ms: unknown;
    waiting_tasks_count: unknown;
  }>`
    select wait_type, wait_time_ms, waiting_tasks_count
    from sys.dm_os_wait_stats
    where wait_type like 'LCK[_]M[_]%'`.execute(admin);
  const waits: WaitSnapshot['waits'] = {};
  for (const row of result.rows) {
    waits[row.wait_type] = {
      waitMs: Number(row.wait_time_ms),
      count: Number(row.waiting_tasks_count),
    };
  }
  return { at: Date.now(), waits };
}

/**
 * Hiệu after - before; chỉ giữ mục có tăng (waitMs hoặc count > 0). wait_type có ở after mà thiếu ở before
 * (lần đầu xuất hiện trong lúc đo) coi như before = 0; wait_type có ở before mà thiếu ở after bị bỏ.
 * Mục có bất kỳ delta âm (bộ đếm bị reset giữa hai lần chụp) bị bỏ vì không đáng tin.
 */
export function diffWaits(
  before: WaitSnapshot,
  after: WaitSnapshot,
): Record<string, { waitMs: number; count: number }> {
  const diff: Record<string, { waitMs: number; count: number }> = {};
  for (const [type, a] of Object.entries(after.waits)) {
    const b = before.waits[type] ?? { waitMs: 0, count: 0 };
    const waitMs = a.waitMs - b.waitMs;
    const count = a.count - b.count;
    if (waitMs < 0 || count < 0) continue;
    if (waitMs > 0 || count > 0) diff[type] = { waitMs, count };
  }
  return diff;
}

export interface BlockedSummary {
  waitType: string;
  /** Câu lệnh đã chuẩn hóa (chữ thường, rút gọn khoảng trắng, tối đa 120 ký tự). */
  statement: string;
  count: number;
  /** Tối đa 3 wait_resource phổ biến nhất của nhóm (không dùng để gom nhóm, tránh phân mảnh). */
  resources?: Array<{ resource: string; count: number }>;
}

export interface BlockedRow {
  waitType: string | null;
  text: string | null;
  resource?: string | null;
}

// Kysely gửi qua sp_executesql nên văn bản bắt đầu bằng khai báo tham số "(@1 nvarchar(4000),@2 int)..."; phải bỏ
// TRƯỚC khi cắt 120 ký tự, nếu không câu lệnh nhiều tham số chỉ còn lại phần khai báo. Chỉ bỏ khi mở đầu bằng "(@".
const PARAM_DECLARATION = /^\(@(?:[^()]|\([^()]*\))*\)/;

export function normalizeStatement(text: string | null | undefined): string {
  const stripped = (text ?? '').trim().replace(PARAM_DECLARATION, '');
  return stripped.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

const TOP_RESOURCES = 3;

/** Gom theo (waitType, câu lệnh chuẩn hóa), sắp giảm dần theo count (hòa: giữ thứ tự xuất hiện đầu tiên). */
export function summarizeBlocked(rows: readonly BlockedRow[]): BlockedSummary[] {
  const groups = new Map<string, BlockedSummary>();
  const resourceCounts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const waitType = row.waitType ?? '';
    const statement = normalizeStatement(row.text);
    const key = `${waitType}\u0000${statement}`;
    const found = groups.get(key);
    if (found) found.count += 1;
    else groups.set(key, { waitType, statement, count: 1 });
    if (row.resource) {
      const per = resourceCounts.get(key) ?? new Map<string, number>();
      per.set(row.resource, (per.get(row.resource) ?? 0) + 1);
      resourceCounts.set(key, per);
    }
  }
  for (const [key, group] of groups) {
    const per = resourceCounts.get(key);
    if (per === undefined) continue;
    group.resources = [...per]
      .map(([resource, count]) => ({ resource, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, TOP_RESOURCES);
  }
  return [...groups.values()].sort((x, y) => y.count - x.count);
}

export interface BlockedSamplerOptions {
  intervalMs?: number;
  databaseName?: string;
  /** Chỉ dành cho test: thay truy vấn DMV. */
  query?: () => Promise<BlockedRow[]>;
}

/**
 * Lấy mẫu định kỳ các request đang bị chặn (blocking_session_id <> 0). `admin` PHẢI là kết nối quản trị RIÊNG
 * (không phải pool đang chịu tải), nếu không mẫu sẽ chính nó xếp hàng sau tải. Lỗi truy vấn không làm hỏng
 * lượt đo nhưng được đếm (errorCount/lastError) để lỗi toàn phần không bị nuốt im lặng.
 */
export class BlockedSampler {
  private readonly intervalMs: number;
  private readonly query: () => Promise<BlockedRow[]>;
  private readonly rows: BlockedRow[] = [];
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  /** Số lần truy vấn lấy mẫu thất bại. */
  errorCount = 0;
  lastError: string | undefined;
  /** Số lần truy vấn lấy mẫu thành công. */
  sampleCount = 0;

  constructor(admin: Kysely<unknown>, options: BlockedSamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 100;
    const databaseName = options.databaseName;
    this.query =
      options.query ??
      (async () => {
        const filter =
          databaseName === undefined ? sql`` : sql`and r.database_id = DB_ID(${databaseName})`;
        // Lấy ĐÚNG câu lệnh hiện hành (offset tính theo byte của nvarchar, -1 = tới hết batch), không phải cả batch.
        const result = await sql<{
          wait_type: string | null;
          wait_resource: string | null;
          text: string | null;
        }>`
          select r.wait_type, r.wait_resource,
            substring(t.text, r.statement_start_offset / 2 + 1,
              (case r.statement_end_offset when -1 then datalength(t.text) else r.statement_end_offset end
                - r.statement_start_offset) / 2 + 1) as text
          from sys.dm_exec_requests r
          cross apply sys.dm_exec_sql_text(r.sql_handle) t
          where r.blocking_session_id <> 0 and r.session_id <> @@SPID ${filter}`.execute(admin);
        return result.rows.map((r) => ({
          waitType: r.wait_type,
          text: r.text,
          resource: r.wait_resource,
        }));
      });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        this.rows.push(...(await this.query()));
        this.sampleCount += 1;
      } catch (error) {
        this.errorCount += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  async stop(): Promise<BlockedSummary[]> {
    this.running = false;
    this.wake?.();
    await this.loop;
    return summarizeBlocked(this.rows);
  }
}
