import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler, once, runAll, startOrExit } from './lifecycle.js';

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

describe('startOrExit', () => {
  function setup() {
    const log = { info: vi.fn(), error: vi.fn() };
    const exit = vi.fn();
    const service = { stop: vi.fn(async () => undefined) };
    return { log, exit, service };
  }

  it('returns the service and neither stops nor exits when startup succeeds', async () => {
    const { log, exit, service } = setup();
    const listen = vi.fn(async () => undefined);
    const result = await startOrExit({ start: async () => service, listen, log, exit });
    expect(result).toBe(service);
    expect(listen).toHaveBeenCalledWith(service);
    expect(service.stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('stops the service, logs and exits 1 when listen fails', async () => {
    const { log, exit, service } = setup();
    const error = new Error('EADDRINUSE');
    await startOrExit({
      start: async () => service,
      listen: async () => {
        throw error;
      },
      log,
      exit,
    });
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({ err: error }, 'failed to start');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still logs and exits 1 when stop also fails', async () => {
    const { log, exit, service } = setup();
    service.stop.mockRejectedValueOnce(new Error('stop failed'));
    const error = new Error('EADDRINUSE');
    await startOrExit({
      start: async () => service,
      listen: async () => {
        throw error;
      },
      log,
      exit,
    });
    expect(log.error).toHaveBeenCalledWith({ err: error }, 'failed to start');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs and exits 1 without stopping when the service could not be created', async () => {
    const { log, exit, service } = setup();
    const error = new Error('db unreachable');
    const listen = vi.fn(async () => undefined);
    await startOrExit({
      start: async () => {
        throw error;
      },
      listen,
      log,
      exit,
    });
    expect(listen).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith({ err: error }, 'failed to start');
    expect(exit).toHaveBeenCalledWith(1);
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
