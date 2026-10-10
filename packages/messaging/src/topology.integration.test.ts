import { createTestBroker, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, testTopology } from './test-helpers.js';
import { declareConsumerTopology, deadLetterQueueName, retryQueueName } from './topology.js';

let broker: TestBroker;
beforeAll(async () => {
  broker = await createTestBroker('topo');
});
afterAll(async () => {
  await broker.drop();
});

describe('declareConsumerTopology (real broker, restricted wallet user)', () => {
  it('declares everything with the least-privilege wallet account, and is idempotent', async () => {
    const topology = testTopology([1, 2]);
    for (let run = 0; run < 2; run++) {
      const connection = await open(broker.wallet);
      const channel = await connection.createChannel();
      await declareConsumerTopology(channel, topology);
      await channel.close();
      await connection.close();
    }
    const admin = await open(broker.admin);
    const channel = await admin.createChannel();
    for (const name of [
      topology.queue,
      retryQueueName(topology.queue, 1),
      retryQueueName(topology.queue, 2),
      deadLetterQueueName(topology.queue),
    ]) {
      await expect(channel.checkQueue(name)).resolves.toMatchObject({ queue: name });
    }
    await admin.close();
  });

  it('fails clearly when a source exchange was not provisioned by the init script', async () => {
    const connection = await open(broker.wallet);
    const channel = await connection.createChannel();
    channel.on('error', () => undefined);
    await expect(
      declareConsumerTopology(channel, {
        ...testTopology(),
        bindings: [{ exchange: 'orders.missing', routingKey: 'x' }],
      }),
    ).rejects.toThrow(/NOT_FOUND|404/);
    await connection.close().catch(() => undefined);
  });
});
