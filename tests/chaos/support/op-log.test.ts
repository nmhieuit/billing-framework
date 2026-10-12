import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpLog } from './op-log.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('OpLog', () => {
  it('ghi và đọc lại theo đúng thứ tự, kèm detail', () => {
    const log = new OpLog();
    log.record('a');
    log.record('b', { x: 1 });
    log.record('c', { y: 'z' });
    const entries = log.entries();
    expect(entries.map((e) => e.kind)).toEqual(['a', 'b', 'c']);
    expect(entries[0]?.detail).toBeUndefined();
    expect(entries[1]?.detail).toEqual({ x: 1 });
    expect(entries[2]?.detail).toEqual({ y: 'z' });
  });

  it('t là số ms không âm, không giảm dần', () => {
    const log = new OpLog();
    for (let i = 0; i < 20; i += 1) log.record('k');
    const ts = log.entries().map((e) => e.t);
    for (const t of ts) expect(t).toBeGreaterThanOrEqual(0);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('entries trả về bản sao, sửa không ảnh hưởng log', () => {
    const log = new OpLog();
    log.record('a');
    (log.entries() as unknown[]).length = 0;
    expect(log.entries()).toHaveLength(1);
  });

  it('writeTo tạo thư mục, ghi JSON đọc lại được và trả về đường dẫn', async () => {
    const base = await mkdtemp(join(tmpdir(), 'op-log-'));
    dirs.push(base);
    const log = new OpLog();
    log.record('start', { seed: 7 });
    log.record('stop');
    const outDir = join(base, 'nested', 'out');
    const path = await log.writeTo(outDir, 'run1');
    expect(path.startsWith(outDir)).toBe(true);
    expect(path).toContain('run1');
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown[];
    expect(parsed).toEqual(JSON.parse(JSON.stringify(log.entries())));
    expect(parsed).toHaveLength(2);
  });
});
