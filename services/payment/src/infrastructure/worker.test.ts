import { waitFor } from '@billing/testing';
import { describe, expect, it } from 'vitest';
import { Worker } from './worker.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Worker', () => {
  it('runs every task on a tick, in order', async () => {
    const order: string[] = [];
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [async () => void order.push('a'), async () => void order.push('b')],
      onError: () => undefined,
    });
    await worker.tick();
    expect(order).toEqual(['a', 'b']);
  });

  it('reports a failing task and still runs the next one', async () => {
    const errors: unknown[] = [];
    let ran = false;
    const boom = new Error('boom');
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async () => {
          throw boom;
        },
        async () => {
          ran = true;
        },
      ],
      onError: (error) => errors.push(error),
    });
    await worker.tick();
    expect(errors).toEqual([boom]);
    expect(ran).toBe(true);
  });

  it('repeats after start() and stops for good after stop()', async () => {
    let runs = 0;
    const worker = new Worker({
      intervalMs: 5,
      tasks: [async () => void runs++],
      onError: () => undefined,
    });
    worker.start();
    await waitFor(() => runs >= 3, { timeoutMs: 2000, intervalMs: 5 });
    await worker.stop();
    const afterStop = runs;
    await sleep(60);
    expect(runs).toBe(afterStop);
  });

  it('stop() waits for the tick that is running', async () => {
    let finished = false;
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async () => {
          await sleep(60);
          finished = true;
        },
      ],
      onError: () => undefined,
    });
    worker.start();
    await sleep(10);
    await worker.stop();
    expect(finished).toBe(true);
  });

  it('never overlaps two ticks', async () => {
    let active = 0;
    let maxActive = 0;
    const worker = new Worker({
      intervalMs: 1,
      tasks: [
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(15);
          active--;
        },
      ],
      onError: () => undefined,
    });
    worker.start();
    await sleep(100);
    await worker.stop();
    expect(maxActive).toBe(1);
  });
});
