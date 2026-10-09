import type { ValidateFunction } from 'ajv/dist/2020.js';
import { ajv } from './ajv.js';
import { envelopeSchema, type Envelope } from './envelope.js';
import { eventSchemas, type EventType } from './events.js';

const validateEnvelope = ajv.compile(envelopeSchema);
const validateData = new Map<EventType, ValidateFunction>(
  (Object.keys(eventSchemas) as EventType[]).map((type) => [type, ajv.compile(eventSchemas[type])]),
);

export type ValidationResult =
  { ok: true; type: EventType; message: Envelope<unknown> } | { ok: false; errors: string[] };

const describe = (fn: ValidateFunction): string[] =>
  (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);

export function validateMessage(raw: unknown): ValidationResult {
  if (!validateEnvelope(raw)) {
    return { ok: false, errors: describe(validateEnvelope) };
  }
  // Đã khớp envelopeSchema ở trên; kiểu ajv suy ra không tương thích với Envelope nên đi qua unknown.
  const message = raw as unknown as Envelope<unknown>;
  const dataValidator = validateData.get(message.type as EventType);
  if (!dataValidator) {
    return { ok: false, errors: [`UNKNOWN_TYPE ${message.type}`] };
  }
  if (!dataValidator(message.data)) {
    return { ok: false, errors: describe(dataValidator).map((e) => `data${e}`) };
  }
  return { ok: true, type: message.type as EventType, message };
}
