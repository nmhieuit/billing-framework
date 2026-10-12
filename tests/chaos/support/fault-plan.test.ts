import { describe, expect, it } from 'vitest';
import { FaultPlan } from './fault-plan.js';
import { OpLog } from './op-log.js';
import { createPrng } from './prng.js';

function setup(seed?: number) {
  const log = new OpLog();
  const plan = new FaultPlan(seed === undefined ? { log } : { log, prng: createPrng(seed) });
  return { log, plan };
}

// Chạy n lần hit, trả về danh sách thứ tự (1-based) các lần có action chạy.
async function firingIndexes(plan: FaultPlan, point: string, n: number, fired: unknown[]) {
  const seen: number[] = [];
  for (let i = 1; i <= n; i += 1) {
    const before = fired.length;
    await plan.hit(point, { i });
    if (fired.length > before) seen.push(i);
  }
  return seen;
}

describe('FaultPlan', () => {
  it('không đặt gì thì kích hoạt mọi lần khớp, không đụng điểm khác', async () => {
    const { plan } = setup();
    const calls: unknown[] = [];
    plan.add({ point: 'p', action: (info) => void calls.push(info) });
    await plan.hit('p', { n: 1 });
    await plan.hit('other', { n: 2 });
    await plan.hit('p', { n: 3 });
    expect(calls).toEqual([{ n: 1 }, { n: 3 }]);
    expect(plan.hits('p')).toBe(2);
    expect(plan.hits('other')).toBe(1);
    expect(plan.hits('never')).toBe(0);
    expect(plan.fired()).toBe(2);
  });

  it('info mặc định là đối tượng rỗng', async () => {
    const { plan } = setup();
    let got: unknown;
    plan.add({ point: 'p', action: (info) => void (got = info) });
    await plan.hit('p');
    expect(got).toEqual({});
  });

  it('nth chỉ kích hoạt đúng lần thứ n', async () => {
    const { plan } = setup();
    const fired: unknown[] = [];
    plan.add({ point: 'p', nth: 3, action: () => void fired.push(1) });
    expect(await firingIndexes(plan, 'p', 8, fired)).toEqual([3]);
    expect(plan.fired()).toBe(1);
  });

  it('when lọc và nth đếm sau khi lọc', async () => {
    const { plan } = setup();
    const fired: unknown[] = [];
    // Chỉ các lần hit có i chẵn khớp: 2,4,6,8,10 nên lần khớp thứ 3 là i=6.
    plan.add({
      point: 'p',
      when: (info) => (info.i as number) % 2 === 0,
      nth: 3,
      action: () => void fired.push(1),
    });
    expect(await firingIndexes(plan, 'p', 10, fired)).toEqual([6]);
    expect(plan.hits('p')).toBe(10);
  });

  it('times giới hạn số lần kích hoạt', async () => {
    const { plan } = setup();
    const fired: unknown[] = [];
    plan.add({ point: 'p', times: 2, action: () => void fired.push(1) });
    expect(await firingIndexes(plan, 'p', 6, fired)).toEqual([1, 2]);
  });

  it('nhiều rule trên cùng điểm đếm độc lập theo từng rule', async () => {
    const { plan } = setup();
    const order: string[] = [];
    plan.add({ point: 'p', nth: 2, label: 'r1', action: () => void order.push('r1') });
    plan.add({ point: 'p', nth: 2, label: 'r2', action: () => void order.push('r2') });
    plan.add({ point: 'p', nth: 3, label: 'r1', action: () => void order.push('r3') });
    for (let i = 0; i < 4; i += 1) await plan.hit('p');
    expect(order).toEqual(['r1', 'r2', 'r3']);
    expect(plan.fired('r1')).toBe(2);
    expect(plan.fired('r2')).toBe(1);
    expect(plan.fired()).toBe(3);
    expect(plan.fired('none')).toBe(0);
  });

  it('probability xác định theo seed: cùng seed cùng chuỗi, và khớp prng.chance', async () => {
    const run = async (seed: number) => {
      const { plan } = setup(seed);
      const fired: unknown[] = [];
      plan.add({ point: 'p', probability: 0.5, action: () => void fired.push(1) });
      return firingIndexes(plan, 'p', 40, fired);
    };
    const a = await run(2024);
    const b = await run(2024);
    expect(a).toEqual(b);
    const ref = createPrng(2024);
    const expected: number[] = [];
    for (let i = 1; i <= 40; i += 1) if (ref.chance(0.5)) expected.push(i);
    expect(a).toEqual(expected);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThan(40);
    expect(await run(2025)).not.toEqual(a);
  });

  it('probability kết hợp times', async () => {
    const { plan } = setup(1);
    const fired: unknown[] = [];
    plan.add({ point: 'p', probability: 1, times: 3, action: () => void fired.push(1) });
    expect(await firingIndexes(plan, 'p', 10, fired)).toEqual([1, 2, 3]);
  });

  it('dùng probability mà không có prng thì ném lỗi rõ ràng', () => {
    const { plan } = setup();
    expect(() => plan.add({ point: 'p', probability: 0.5, action: () => undefined })).toThrow(
      /prng/,
    );
  });

  it('disable làm hit không làm gì (kể cả không đếm), enable bật lại', async () => {
    const { plan, log } = setup();
    let count = 0;
    plan.add({ point: 'p', action: () => void (count += 1) });
    plan.disable();
    await plan.hit('p');
    expect(count).toBe(0);
    expect(plan.hits('p')).toBe(0);
    expect(log.entries()).toHaveLength(0);
    plan.enable();
    await plan.hit('p');
    expect(count).toBe(1);
    expect(plan.hits('p')).toBe(1);
  });

  it('clear xoá rule và đặt lại bộ đếm hit/fired', async () => {
    const { plan } = setup();
    let count = 0;
    plan.add({ point: 'p', action: () => void (count += 1) });
    await plan.hit('p');
    expect(plan.fired()).toBe(1);
    plan.clear();
    expect(plan.fired()).toBe(0);
    expect(plan.hits('p')).toBe(0);
    await plan.hit('p');
    expect(count).toBe(1);
    expect(plan.hits('p')).toBe(1);
    expect(plan.fired()).toBe(0);
  });

  it('action ném lỗi thì lỗi truyền lên người gọi và vẫn ghi log + đếm', async () => {
    const { plan, log } = setup();
    plan.add({
      point: 'p',
      label: 'boom',
      action: () => {
        throw new Error('fake failure');
      },
    });
    await expect(plan.hit('p')).rejects.toThrow('fake failure');
    expect(plan.fired('boom')).toBe(1);
    expect(log.entries()).toHaveLength(1);
  });

  it('action bất đồng bộ được await trước khi hit trả về', async () => {
    const { plan } = setup();
    let done = false;
    plan.add({
      point: 'p',
      action: async () => {
        await new Promise((r) => setTimeout(r, 5));
        done = true;
      },
    });
    await plan.hit('p');
    expect(done).toBe(true);
  });

  it('mỗi lần kích hoạt có đúng một mục log kind=fault với point và label', async () => {
    const { plan, log } = setup();
    plan.add({ point: 'p', nth: 2, label: 'crash-2', action: () => undefined });
    plan.add({ point: 'q', action: () => undefined });
    await plan.hit('p');
    await plan.hit('p');
    await plan.hit('q');
    const faults = log.entries().filter((e) => e.kind === 'fault');
    expect(faults).toHaveLength(2);
    expect(faults[0]?.detail).toMatchObject({ point: 'p', label: 'crash-2' });
    expect(faults[1]?.detail).toMatchObject({ point: 'q' });
    expect(log.entries()).toHaveLength(2);
  });
});
