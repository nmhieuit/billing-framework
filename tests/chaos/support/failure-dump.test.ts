import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dumpFailedTask, dumpName, recordTaskFailure } from './failure-dump.js';
import { OpLog } from './op-log.js';
import type { System } from './system-harness.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fakeSystem = (heal: () => Promise<void>) =>
  ({ log: new OpLog(), seed: 9, heal }) as unknown as System;

describe('failure-dump', () => {
  it('dumpName rút gọn và gắn seed', () => {
    expect(dumpName('S6: a/b c', 5)).toBe('S6-a-b-c-seed5');
  });

  it('recordTaskFailure ghi thông điệp lỗi vào OpLog', () => {
    const log = new OpLog();
    recordTaskFailure(log, { name: 't', result: { state: 'fail', errors: [{ message: 'boom' }] } });
    expect(log.entries()[0]).toMatchObject({
      kind: 'test.failure',
      detail: { test: 't', errors: ['boom'] },
    });
  });

  it('test thất bại: tệp nhật ký chứa lý do, rồi heal best-effort; heal lỗi không ném', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = await mkdtemp(join(tmpdir(), 'dump-'));
    dirs.push(dir);
    const heal = vi.fn(async () => {
      throw new Error('heal hỏng');
    });
    const system = fakeSystem(heal);
    await dumpFailedTask(
      { name: 'x y', result: { state: 'fail', errors: [{ message: 'expected 1 got 2' }] } },
      system,
      dir,
    );
    const written = JSON.parse(await readFile(join(dir, 'x-y-seed9.json'), 'utf8')) as Array<{
      kind: string;
      detail: { errors: string[] };
    }>;
    expect(written[0]?.kind).toBe('test.failure');
    expect(written[0]?.detail.errors).toEqual(['expected 1 got 2']);
    expect(heal).toHaveBeenCalledOnce();
  });

  it('test đạt: không ghi gì và không heal', async () => {
    const heal = vi.fn(async () => undefined);
    await dumpFailedTask(
      { name: 'ok', result: { state: 'pass' } },
      fakeSystem(heal),
      '/nonexistent',
    );
    expect(heal).not.toHaveBeenCalled();
  });
});
