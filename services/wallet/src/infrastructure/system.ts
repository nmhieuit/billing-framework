import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../application/ports.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator implements IdGenerator {
  topupId(): string {
    return `tp_${randomUUID().replaceAll('-', '')}`;
  }

  transactionId(): string {
    return `tx_${randomUUID().replaceAll('-', '')}`;
  }

  eventId(): string {
    return randomUUID();
  }
}
