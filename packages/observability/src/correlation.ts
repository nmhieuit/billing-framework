import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<string>();

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run(correlationId, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore();
}

export function resolveCorrelationId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && UUID.test(incoming) ? incoming : randomUUID();
}
