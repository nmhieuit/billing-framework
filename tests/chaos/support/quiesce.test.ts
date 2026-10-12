import { describe, expect, it } from 'vitest';
import { quiesce } from './quiesce.js';

// Dùng timer thật với khoảng chờ nhỏ để tránh flakiness.
describe('quiesce', () => {
  it('trả về ngay khi mọi điều kiện đã đạt', async () => {
    await expect(
      quiesce([{ name: 'a', check: async () => true }], { timeoutMs: 500, intervalMs: 5 }),
    ).resolves.toBeUndefined();
  });

  it('danh sách rỗng thì xong ngay', async () => {
    await expect(quiesce([], { timeoutMs: 100, intervalMs: 5 })).resolves.toBeUndefined();
  });

  it('đạt sau vài vòng và kiểm tra lại điều kiện mỗi vòng', async () => {
    let calls = 0;
    await quiesce(
      [
        {
          name: 'slow',
          check: async () => {
            calls += 1;
            return calls >= 4;
          },
        },
        { name: 'fast', check: async () => true },
      ],
      { timeoutMs: 2000, intervalMs: 5 },
    );
    expect(calls).toBe(4);
  });

  it('hết hạn thì ném lỗi chỉ nêu tên các điều kiện chưa đạt', async () => {
    const promise = quiesce(
      [
        { name: 'ok-cond', check: async () => true },
        { name: 'stuck-one', check: async () => false },
        { name: 'stuck-two', check: async () => false },
      ],
      { timeoutMs: 60, intervalMs: 5 },
    );
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('stuck-one');
    expect(error?.message).toContain('stuck-two');
    expect(error?.message).not.toContain('ok-cond');
  });

  it('điều kiện ném lỗi coi như chưa đạt, không phá vòng lặp và có thể đạt về sau', async () => {
    let calls = 0;
    await quiesce(
      [
        {
          name: 'flaky',
          check: async () => {
            calls += 1;
            if (calls < 3) throw new Error('chưa sẵn sàng');
            return true;
          },
        },
      ],
      { timeoutMs: 2000, intervalMs: 5 },
    );
    expect(calls).toBe(3);
  });

  it('điều kiện luôn ném lỗi thì hết hạn và thông báo kèm lỗi cuối cùng', async () => {
    const promise = quiesce(
      [
        {
          name: 'always-throws',
          check: async () => {
            throw new Error('db down');
          },
        },
      ],
      { timeoutMs: 50, intervalMs: 5 },
    );
    await expect(promise).rejects.toThrow(/always-throws/);
    await expect(promise).rejects.toThrow(/db down/);
  });
});
