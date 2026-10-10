import { describe, expect, it, vi } from 'vitest';
import { BackgroundRuns } from './background-runs.js';
import type { Logger } from './ports.js';

const logger = (): Logger & { errors: object[] } => {
  const errors: object[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (details) => {
      errors.push(details);
    },
  };
};

describe('BackgroundRuns', () => {
  it('drain waits for work that is still running', async () => {
    const background = new BackgroundRuns(logger());
    let finished = false;
    background.submit({}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });
    await background.drain();
    expect(finished).toBe(true);
  });

  it('logs a failure instead of leaving an unhandled rejection, and keeps draining', async () => {
    const log = logger();
    const background = new BackgroundRuns(log);
    background.submit({ runId: 'r1' }, () => Promise.reject(new Error('boom')));
    background.submit({ runId: 'r2' }, () => {
      throw new Error('sync boom');
    });
    await background.drain();
    expect(log.errors).toHaveLength(2);
    // Thứ tự ghi log theo thời điểm lỗi xảy ra (lỗi đồng bộ đến trước), nên so khớp không phụ thuộc thứ tự.
    expect(log.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'r1' }),
        expect.objectContaining({ runId: 'r2' }),
      ]),
    );
  });

  it('drain returns at once when nothing is pending', async () => {
    const spy = vi.fn();
    await new BackgroundRuns(logger()).drain();
    expect(spy).not.toHaveBeenCalled();
  });
});
