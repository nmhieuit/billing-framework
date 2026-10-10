import type { BrokerClient } from '@billing/messaging';
import type { QueueDepthReader } from '../application/ports.js';

/** Đọc độ sâu queue qua `BrokerClient`; `null` khi broker không trả được số liệu. */
export class BrokerQueueDepthReader implements QueueDepthReader {
  constructor(private readonly broker: Pick<BrokerClient, 'queueDepth'>) {}

  async depth(queue: string): Promise<number | null> {
    return (await this.broker.queueDepth(queue)) ?? null;
  }
}
