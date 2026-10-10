import { validateEvent, type OrderReadyForPaymentV1 } from '@billing/contracts';

export type DecodeResult =
  { ok: true; event: OrderReadyForPaymentV1 } | { ok: false; reason: string };

/** Biến thân message thành `OrderReadyForPaymentV1` đã kiểm schema; trường lạ được bỏ qua (tolerant reader). */
export function decodeOrderReady(body: Buffer | string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body is not valid JSON' };
  }
  const result = validateEvent('OrderReadyForPaymentV1', json);
  if (!result.ok) {
    return { ok: false, reason: `schema validation failed: ${result.errors.join('; ')}` };
  }
  return { ok: true, event: result.event };
}
