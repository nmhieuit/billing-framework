import { describe, expect, it } from 'vitest';
import { defaultClassify, runClosedLoop } from './load-driver.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Đồng hồ giả: mỗi tác vụ tự tiến đồng hồ đúng bằng độ trễ "giả" của nó, nên kết quả tất định (không phụ thuộc máy).
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('runClosedLoop', () => {
  it('không bao giờ chạy quá concurrency thao tác cùng lúc (và đạt đúng concurrency)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await runClosedLoop({
      concurrency: 4,
      durationMs: 150,
      warmupMs: 0,
      task: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight -= 1;
      },
    });
    expect(maxInFlight).toBe(4);
    expect(inFlight).toBe(0);
    expect(result.ok).toBeGreaterThan(0);
  });

  it('thao tác hoàn tất trong khởi động nóng hoặc sau cửa sổ đo không được tính', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await runClosedLoop({
      concurrency: 1,
      warmupMs: 50,
      durationMs: 100,
      now: clock.now,
      task: async () => {
        calls += 1;
        clock.advance(10);
      },
    });
    // Thao tác hoàn tất ở 10..150 (15 lần gọi); cửa sổ đo là [50,150): hoàn tất ở 50..140 → 10 thao tác.
    // Thao tác hoàn tất ở 10..40 (khởi động nóng) và ở 150 (đúng lúc hết cửa sổ, đang bay) không tính.
    expect(calls).toBe(15);
    expect(result.ok).toBe(10);
    expect(result.latenciesMs).toEqual(Array.from({ length: 10 }, () => 10));
    expect(result.elapsedMs).toBe(100);
    expect(result.throughputPerSec).toBe(100); // 10 / 0.1 s
  });

  it('chờ thao tác đang bay khi hết cửa sổ nhưng không tính nó', async () => {
    const clock = fakeClock();
    let finishedAfterWindow = 0;
    const result = await runClosedLoop({
      concurrency: 1,
      warmupMs: 0,
      durationMs: 100,
      now: clock.now,
      task: async ({ seq }) => {
        // Thao tác thứ 4 (seq 3) bắt đầu ở 90 và kéo dài 60 → hoàn tất ở 150, sau cửa sổ.
        clock.advance(seq === 3 ? 60 : 30);
        if (seq === 3) finishedAfterWindow += 1;
      },
    });
    expect(finishedAfterWindow).toBe(1); // vẫn được chờ xong
    expect(result.ok).toBe(3); // hoàn tất ở 30, 60, 90
    expect(result.latenciesMs).toEqual([30, 30, 30]);
  });

  it('phân loại lỗi: 1205 → deadlock, timeout, còn lại other; lỗi không dừng worker', async () => {
    const clock = fakeClock();
    const errors: unknown[] = [
      Object.assign(new Error('Transaction was deadlocked'), { number: 1205 }),
      new Error('Request timeout: failed to complete in 15000ms'),
      new Error('boom'),
      Object.assign(new Error('x'), { code: 'ETIMEOUT' }),
      new Error('wrapper', { cause: Object.assign(new Error('inner'), { number: 1205 }) }),
      Object.assign(new Error('wrapper'), { originalError: { number: 1205 } }),
    ];
    const result = await runClosedLoop({
      concurrency: 1,
      warmupMs: 0,
      durationMs: 70,
      now: clock.now,
      task: async ({ seq }) => {
        clock.advance(10);
        throw errors[seq % errors.length];
      },
    });
    expect(result.ok).toBe(0);
    expect(result.errors).toEqual({ deadlock: 3, timeout: 2, other: 1 });
    expect(result.latenciesMs).toEqual([]); // độ trễ chỉ ghi cho thao tác thành công
  });

  it('classify tùy chỉnh được dùng thay mặc định', async () => {
    const clock = fakeClock();
    const result = await runClosedLoop({
      concurrency: 1,
      warmupMs: 0,
      durationMs: 30,
      now: clock.now,
      classify: () => 'deadlock',
      task: async () => {
        clock.advance(10);
        throw new Error('boom');
      },
    });
    expect(result.errors).toEqual({ deadlock: 2, timeout: 0, other: 0 });
  });

  it('lỗi tức thì liên tục không làm đói event loop (nhường mỗi vòng)', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    let calls = 0;
    try {
      const result = await runClosedLoop({
        concurrency: 2,
        warmupMs: 0,
        durationMs: 120,
        task: async () => {
          calls += 1;
          throw new Error('fail fast');
        },
      });
      // Kiểm ngay sau khi chạy xong: nếu vòng lặp không nhường macrotask thì timer chưa kịp chạy lần nào.
      expect(ticks).toBeGreaterThanOrEqual(5);
      expect(result.errors.other).toBeGreaterThan(0);
      expect(calls).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it('truyền worker và seq (seq tăng dần theo từng worker)', async () => {
    const clock = fakeClock();
    const seen: Array<[number, number]> = [];
    await runClosedLoop({
      concurrency: 1,
      warmupMs: 0,
      durationMs: 30,
      now: clock.now,
      task: async ({ worker, seq }) => {
        seen.push([worker, seq]);
        clock.advance(10);
      },
    });
    expect(seen).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
  });

  it.each([
    { concurrency: 0, durationMs: 10, warmupMs: 0 },
    { concurrency: 1.5, durationMs: 10, warmupMs: 0 },
    { concurrency: 1, durationMs: 0, warmupMs: 0 },
    { concurrency: 1, durationMs: 10, warmupMs: -1 },
  ])('từ chối tùy chọn sai %j', async (opts) => {
    await expect(runClosedLoop({ ...opts, task: async () => undefined })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('defaultClassify', () => {
  it('nhận 1205 qua number, cause, originalError và precedingErrors; timeout qua code/message/1222', () => {
    expect(defaultClassify({ number: 1205 })).toBe('deadlock');
    expect(defaultClassify({ cause: { cause: { number: 1205 } } })).toBe('deadlock');
    expect(defaultClassify({ originalError: { number: 1205 } })).toBe('deadlock');
    expect(defaultClassify({ precedingErrors: [{ number: 1205 }] })).toBe('deadlock');
    expect(defaultClassify({ code: 'ETIMEOUT' })).toBe('timeout');
    expect(defaultClassify({ number: 1222 })).toBe('timeout'); // lock request time out
    expect(defaultClassify(new Error('Timed out acquiring connection'))).toBe('timeout');
    expect(defaultClassify('chuỗi lạ')).toBe('other');
    expect(defaultClassify(undefined)).toBe('other');
    expect(defaultClassify({ number: 547 })).toBe('other');
  });

  it('chịu được vòng tham chiếu cause', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(defaultClassify(a)).toBe('other');
  });
});
