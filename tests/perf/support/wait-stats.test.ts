import { describe, expect, it } from 'vitest';
import {
  BlockedSampler,
  diffWaits,
  normalizeStatement,
  summarizeBlocked,
  type WaitSnapshot,
} from './wait-stats.js';

const snap = (waits: WaitSnapshot['waits']): WaitSnapshot => ({ at: 0, waits });

describe('diffWaits', () => {
  it('chỉ giữ mục có delta dương và tính đúng hiệu', () => {
    const before = snap({
      LCK_M_X: { waitMs: 100, count: 10 },
      LCK_M_S: { waitMs: 50, count: 5 },
    });
    const after = snap({
      LCK_M_X: { waitMs: 350, count: 14 },
      LCK_M_S: { waitMs: 50, count: 5 }, // không đổi → bỏ
    });
    expect(diffWaits(before, after)).toEqual({ LCK_M_X: { waitMs: 250, count: 4 } });
  });

  it('bỏ qua loại chỉ có ở một phía', () => {
    const before = snap({ LCK_M_U: { waitMs: 10, count: 1 } });
    const after = snap({ LCK_M_X: { waitMs: 500, count: 9 } });
    expect(diffWaits(before, after)).toEqual({});
  });

  it('không trả delta âm (bộ đếm bị reset giữa chừng)', () => {
    const before = snap({ LCK_M_X: { waitMs: 900, count: 90 } });
    const after = snap({ LCK_M_X: { waitMs: 100, count: 10 } });
    expect(diffWaits(before, after)).toEqual({});
  });

  it('giữ mục chỉ tăng số lần chờ (waitMs làm tròn không đổi)', () => {
    const before = snap({ LCK_M_X: { waitMs: 100, count: 1 } });
    const after = snap({ LCK_M_X: { waitMs: 100, count: 2 } });
    expect(diffWaits(before, after)).toEqual({ LCK_M_X: { waitMs: 0, count: 1 } });
  });
});

describe('normalizeStatement', () => {
  it('chữ thường, rút gọn khoảng trắng, tối đa 120 ký tự', () => {
    expect(normalizeStatement('  UPDATE   Hot\n\tSET v =  v + 1 ')).toBe(
      'update hot set v = v + 1',
    );
    expect(normalizeStatement('x'.repeat(500))).toHaveLength(120);
    expect(normalizeStatement(null)).toBe('');
  });
});

describe('summarizeBlocked', () => {
  it('gom theo (waitType, câu lệnh chuẩn hóa), sắp giảm dần theo count', () => {
    const rows = [
      { waitType: 'LCK_M_X', text: 'UPDATE hot  set v = 1' },
      { waitType: 'LCK_M_U', text: 'select 1' },
      { waitType: 'LCK_M_X', text: 'update hot set v = 1' },
      { waitType: 'LCK_M_X', text: 'update hot set v = 1' },
      { waitType: 'LCK_M_X', text: 'update hot set v = 2' },
    ];
    expect(summarizeBlocked(rows)).toEqual([
      { waitType: 'LCK_M_X', statement: 'update hot set v = 1', count: 3 },
      { waitType: 'LCK_M_U', statement: 'select 1', count: 1 },
      { waitType: 'LCK_M_X', statement: 'update hot set v = 2', count: 1 },
    ]);
  });
});

describe('BlockedSampler', () => {
  it('lỗi truy vấn của sampler không làm hỏng lượt đo và được đếm', async () => {
    let call = 0;
    const sampler = new BlockedSampler({} as never, {
      intervalMs: 5,
      query: async () => {
        call += 1;
        if (call % 2 === 1) throw new Error('admin connection lost');
        return [{ waitType: 'LCK_M_X', text: 'update hot set v = 1' }];
      },
    });
    sampler.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const summary = await sampler.stop();
    expect(sampler.errorCount).toBeGreaterThan(0);
    expect(sampler.lastError).toContain('admin connection lost');
    expect(summary[0]?.statement).toBe('update hot set v = 1');
  });

  it('báo lỗi nếu mọi truy vấn đều hỏng (không im lặng): errorCount = số lần thử, mẫu = 0', async () => {
    const sampler = new BlockedSampler({} as never, {
      intervalMs: 5,
      query: async () => {
        throw new Error('permission denied');
      },
    });
    sampler.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await sampler.stop()).toEqual([]);
    expect(sampler.errorCount).toBeGreaterThan(0);
    expect(sampler.sampleCount).toBe(0);
  });

  it('stop() dừng hẳn: không còn truy vấn nào sau khi stop', async () => {
    let calls = 0;
    const sampler = new BlockedSampler({} as never, {
      intervalMs: 5,
      query: async () => {
        calls += 1;
        return [];
      },
    });
    sampler.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await sampler.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(after);
  });
});
