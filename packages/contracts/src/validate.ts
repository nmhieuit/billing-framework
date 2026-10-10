import type { ValidateFunction } from 'ajv/dist/2020.js';
import { ajv } from './ajv.js';
import { eventCatalog, type EventName, type EventPayloads } from './events.js';

const validators = new Map<EventName, ValidateFunction>(
  (Object.keys(eventCatalog) as EventName[]).map((name) => [
    name,
    ajv.compile(eventCatalog[name].schema),
  ]),
);

export type ValidationResult<T> = { ok: true; event: T } | { ok: false; errors: string[] };

/** Kiểm tra một event đã parse theo schema của nó; trường lạ được bỏ qua (tolerant reader). */
export function validateEvent<N extends EventName>(
  name: N,
  raw: unknown,
): ValidationResult<EventPayloads[N]> {
  const validate = validators.get(name);
  if (!validate) return { ok: false, errors: [`UNKNOWN_EVENT ${name}`] };
  if (!validate(raw)) {
    return {
      ok: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      ),
    };
  }
  // Đã khớp schema ở trên; kiểu ajv suy ra không tương thích với EventPayloads nên đi qua unknown.
  return { ok: true, event: raw as unknown as EventPayloads[N] };
}
