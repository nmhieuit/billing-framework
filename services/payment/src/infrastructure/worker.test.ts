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

  it('passes an AbortSignal to every task, aborted by stop(), which unblocks a waiting task', async () => {
    const signals: AbortSignal[] = [];
    let unblocked = false;
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async (signal) => {
          signals.push(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          unblocked = true;
        },
      ],
      onError: () => undefined,
    });
    worker.start();
    await waitFor(() => signals.length === 1, { timeoutMs: 2000, intervalMs: 5 });
    expect(signals[0]?.aborted).toBe(false);
    await worker.stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(unblocked).toBe(true);
  });

  it('does not run the remaining tasks of a tick once the signal is aborted', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async () => {
          order.push('a');
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        async () => void order.push('b'),
      ],
      onError: () => undefined,
    });
    worker.start();
    await waitFor(() => order.length === 1, { timeoutMs: 2000, intervalMs: 5 });
    const stopping = worker.stop();
    release();
    await stopping;
    expect(order).toEqual(['a']);
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

  it('survives an onError that throws: later tasks still run and tick() resolves', async () => {
    let ran = false;
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async () => {
          throw new Error('task failed');
        },
        async () => {
          ran = true;
        },
      ],
      onError: () => {
        throw new Error('handler failed');
      },
    });
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it('keeps looping when both the task and onError throw, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      let runs = 0;
      const worker = new Worker({
        intervalMs: 5,
        tasks: [
          async () => {
            runs++;
            throw new Error('task failed');
          },
        ],
        onError: () => {
          throw new Error('handler failed');
        },
      });
      worker.start();
      await waitFor(() => runs >= 3, { timeoutMs: 2000, intervalMs: 5 });
      await expect(worker.stop()).resolves.toBeUndefined();
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
