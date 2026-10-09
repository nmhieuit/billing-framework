import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventSchemas } from './events.js';
import { emitSchemas } from './index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'contracts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('emitSchemas', () => {
  it('writes the envelope and one file per event type', async () => {
    const written = await emitSchemas(dir);
    expect(written).toHaveLength(1 + Object.keys(eventSchemas).length);
    const paid = JSON.parse(await readFile(join(dir, 'billing.order-paid.v1.json'), 'utf8'));
    expect(paid).toEqual(eventSchemas['billing.order-paid.v1']);
    const envelope = JSON.parse(await readFile(join(dir, 'envelope.v1.json'), 'utf8'));
    expect(envelope.$id).toBe('urn:billing:schema:envelope:v1');
  });
});
