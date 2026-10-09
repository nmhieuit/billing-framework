import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, runWithCorrelation } from './index.js';

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('stamps service name and the active correlation id', () => {
    const { lines, stream } = capture();
    const log = createLogger('wallet', stream);
    runWithCorrelation('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02', () => log.info('hello'));
    expect(lines[0]).toMatchObject({
      service: 'wallet',
      msg: 'hello',
      correlationId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
    });
  });

  it('omits correlationId when there is no context', () => {
    const { lines, stream } = capture();
    createLogger('payment', stream).info('boot');
    expect(lines[0]).not.toHaveProperty('correlationId');
  });
});
