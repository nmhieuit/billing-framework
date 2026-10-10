import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventCatalog, emitSchemas } from './index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'contracts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('emitSchemas', () => {
  it('writes one schema file per event plus the payment webhook schema', async () => {
    const written = await emitSchemas(dir);
    expect(written).toHaveLength(Object.keys(eventCatalog).length + 1);
    const paid = JSON.parse(await readFile(join(dir, 'OrderPaid.v1.schema.json'), 'utf8'));
    expect(paid).toEqual(eventCatalog.OrderPaidV1.schema);
    expect(paid.$id).toBe('urn:billing:schema:OrderPaid:v1');
    const webhook = JSON.parse(await readFile(join(dir, 'payment.charge-event.v1.json'), 'utf8'));
    expect(webhook.$id).toBe('urn:billing:schema:payment.charge-event:v1');
  });

  it('emits no envelope schema any more', async () => {
    await emitSchemas(dir);
    await expect(readFile(join(dir, 'envelope.v1.json'), 'utf8')).rejects.toThrow();
  });
});
