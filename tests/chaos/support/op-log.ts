import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface OpLogEntry {
  /** Mili giây kể từ lúc tạo log. */
  t: number;
  kind: string;
  detail?: Record<string, unknown>;
}

// Nhật ký thao tác theo thứ tự thời gian, dùng để dựng lại diễn biến khi test chaos thất bại.
export class OpLog {
  private readonly startedAt = performance.now();
  private readonly items: OpLogEntry[] = [];

  record(kind: string, detail?: Record<string, unknown>): void {
    const entry: OpLogEntry = { t: Math.round(performance.now() - this.startedAt), kind };
    if (detail !== undefined) entry.detail = detail;
    this.items.push(entry);
  }

  entries(): readonly OpLogEntry[] {
    return [...this.items];
  }

  async writeTo(dir: string, name: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.json`);
    await writeFile(path, JSON.stringify(this.items, null, 2), 'utf8');
    return path;
  }
}
