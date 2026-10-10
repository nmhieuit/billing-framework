import { describe, expect, it } from 'vitest';
import { TenantId } from '../domain/tenant-id.js';
import { InlineTopupSubmitter } from './inline-topup-submitter.js';
import type { Logger } from './ports.js';

const acme = TenantId.parse('acme');

function setup(executeFor: (tenant: TenantId, topupId: string) => Promise<unknown>) {
  const errors: Array<{ details: object; message: string | undefined }> = [];
  const log: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (details, message) => errors.push({ details, message }),
  };
  const calls: Array<[string, string]> = [];
  const submitter = new InlineTopupSubmitter({
    submit: {
      executeFor: (tenant, topupId) => {
        calls.push([tenant.value, topupId]);
        return executeFor(tenant, topupId) as never;
      },
    },
    log,
  });
  return { submitter, errors, calls };
}

describe('InlineTopupSubmitter', () => {
  it('starts the submission immediately and does not wait for it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { submitter, calls } = setup(() => gate);

    expect(submitter.submitSoon(acme, 'tp_1')).toBeUndefined();
    expect(calls).toEqual([['acme', 'tp_1']]);

    let drained = false;
    const draining = submitter.drain().then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
  });

  it('logs a failed submission instead of letting it escape, and drain() still settles', async () => {
    const { submitter, errors } = setup(() => Promise.reject(new Error('boom')));
    submitter.submitSoon(acme, 'tp_2');
    await submitter.drain();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.details).toMatchObject({ tenantId: 'acme', topupId: 'tp_2' });
  });

  it('also survives an executeFor that throws synchronously', async () => {
    const { submitter, errors } = setup(() => {
      throw new Error('sync boom');
    });
    expect(() => submitter.submitSoon(acme, 'tp_3')).not.toThrow();
    await submitter.drain();
    expect(errors).toHaveLength(1);
  });

  it('resolves drain() immediately when nothing is running', async () => {
    const { submitter } = setup(() => Promise.resolve());
    await expect(submitter.drain()).resolves.toBeUndefined();
  });

  it('keeps going when the logger itself throws', async () => {
    const submitter = new InlineTopupSubmitter({
      submit: { executeFor: () => Promise.reject(new Error('boom')) },
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => {
          throw new Error('logger down');
        },
      },
    });
    submitter.submitSoon(acme, 'tp_4');
    await expect(submitter.drain()).resolves.toBeUndefined();
  });
});
