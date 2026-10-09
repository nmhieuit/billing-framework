import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler, once, runAll } from './lifecycle.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('runAll', () => {
  it('runs every step in order even when the first throws, then rejects with the first error', async () => {
    const calls: string[] = [];
    const first = new Error('first');
    const steps = [
      async () => {
        calls.push('a');
        throw first;
      },
      async () => {
        calls.push('b');
        throw new Error('second');
      },
      async () => {
        calls.push('c');
      },
    ];
    await expect(runAll(steps)).rejects.toBe(first);
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('resolves when all steps succeed', async () => {
    await expect(runAll([async () => undefined, async () => undefined])).resolves.toBeUndefined();
  });
});

describe('once', () => {
  it('runs the function a single time and shares its promise', async () => {
    const fn = vi.fn(async () => undefined);
    const stop = once(fn);
    const a = stop();
    const b = stop();
    await Promise.all([a, b]);
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps returning the same rejection without rerunning', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    const stop = once(fn);
    await expect(stop()).rejects.toThrow('boom');
    await expect(stop()).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createShutdownHandler', () => {
  function setup(stop: () => Promise<void>) {
    const log = { info: vi.fn(), error: vi.fn() };
    const exit = vi.fn();
    const handler = createShutdownHandler({ stop, log, exit });
    return { log, exit, handler };
  }

  it('ignores a second signal while shutting down', async () => {
    let release: () => void = () => undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { handler, exit, log } = setup(stop);
    handler('SIGINT');
    handler('SIGTERM');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 0 on success', async () => {
    const { handler, exit, log } = setup(async () => undefined);
    handler('SIGTERM');
    await flush();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs the error and exits 1 when stop rejects', async () => {
    const error = new Error('close failed');
    const { handler, exit, log } = setup(async () => {
      throw error;
    });
    handler('SIGINT');
    await flush();
    expect(log.error).toHaveBeenCalledWith({ err: error }, expect.any(String));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
