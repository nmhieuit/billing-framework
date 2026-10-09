import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../application/ports.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator implements IdGenerator {
  chargeId(): string {
    return `ch_${randomUUID().replaceAll('-', '')}`;
  }

  eventId(): string {
    return `evt_${randomUUID().replaceAll('-', '')}`;
  }
}
