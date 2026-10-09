import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FromSchema } from 'json-schema-to-ts';
import { ajv } from './ajv.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export const chargeWebhookSchema = {
  $id: 'urn:billing:schema:payment.charge-event:v1',
  type: 'object',
  required: ['eventId', 'type', 'createdAt', 'data'],
  properties: {
    eventId: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: ['charge.succeeded', 'charge.failed'] },
    createdAt: { type: 'string', format: 'date-time' },
    data: {
      type: 'object',
      required: ['chargeId', 'reference', 'amount', 'currency', 'status', 'completedAt'],
      properties: {
        chargeId: { type: 'string', minLength: 1 },
        reference: { type: 'string', minLength: 1 },
        amount: { type: 'integer', minimum: 1 },
        currency: { type: 'string', enum: ['VND', 'USD'] },
        status: { type: 'string', enum: ['SUCCEEDED', 'FAILED'] },
        completedAt: { type: 'string', format: 'date-time' },
        failureCode: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
      },
    },
  },
} as const;

export type ChargeWebhookPayload = FromSchema<typeof chargeWebhookSchema>;

export type ChargeWebhookResult =
  { ok: true; payload: ChargeWebhookPayload } | { ok: false; errors: string[] };

const validatePayload = ajv.compile(chargeWebhookSchema);

export function validateChargeWebhook(raw: unknown): ChargeWebhookResult {
  if (!validatePayload(raw)) {
    const errors = (validatePayload.errors ?? []).map(
      (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
    );
    return { ok: false, errors };
  }
  const payload = raw as unknown as ChargeWebhookPayload;
  const errors: string[] = [];
  if (payload.type === 'charge.succeeded') {
    if (payload.data.status !== 'SUCCEEDED')
      errors.push('charge.succeeded requires status SUCCEEDED');
    if (payload.data.failureCode !== undefined)
      errors.push('charge.succeeded must not carry failureCode');
  } else {
    if (payload.data.status !== 'FAILED') errors.push('charge.failed requires status FAILED');
    if (payload.data.failureCode === undefined) errors.push('charge.failed requires failureCode');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, payload };
}

export function signWebhook(secret: string, body: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export type VerifyWebhookResult =
  { ok: true } | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'MISMATCH' };

export interface VerifyWebhookInput {
  secret: string;
  body: string;
  header: string | undefined;
  nowSeconds: number;
  toleranceSeconds?: number;
}

function parseHeader(header: string | undefined): { t: number; v1: string } | undefined {
  if (header === undefined) return undefined;
  const parts = new Map<string, string>();
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index > 0) parts.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (t === undefined || v1 === undefined) return undefined;
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) return undefined;
  return { t: Number(t), v1 };
}

/** So chữ ký bằng timingSafeEqual; kiểm tra chữ ký trước rồi mới kiểm tra thời gian. */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  const parsed = parseHeader(input.header);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };

  const expected = createHmac('sha256', input.secret).update(`${parsed.t}.${input.body}`).digest();
  const actual = Buffer.from(parsed.v1, 'hex');
  if (!timingSafeEqual(actual, expected)) return { ok: false, reason: 'MISMATCH' };

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Fail CLOSED: NaN/Infinity/negative inputs must never disable replay protection.
  const withinTolerance =
    Number.isFinite(input.nowSeconds) &&
    Number.isFinite(tolerance) &&
    tolerance >= 0 &&
    Math.abs(input.nowSeconds - parsed.t) <= tolerance;
  return withinTolerance ? { ok: true } : { ok: false, reason: 'EXPIRED' };
}
