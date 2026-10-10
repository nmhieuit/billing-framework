import { InvalidChargeError } from './errors.js';

export type Metadata = Readonly<Record<string, string>>;

export const EMPTY_METADATA: Metadata = {};
export const MAX_METADATA_KEYS = 10;
export const MAX_METADATA_VALUE_LENGTH = 200;

const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/** Kiểm tra metadata do bên gọi gửi; trả về bản có khóa đã sắp xếp (dạng chuẩn để băm và lưu). */
export function parseMetadata(raw: unknown): Metadata {
  if (raw === undefined) return EMPTY_METADATA;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidChargeError('metadata must be an object of string values');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new InvalidChargeError(`metadata allows at most ${MAX_METADATA_KEYS} keys`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!KEY.test(key)) {
      throw new InvalidChargeError(`metadata key "${key}" must match ${KEY.source}`);
    }
    if (typeof value !== 'string' || value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new InvalidChargeError(
        `metadata value for "${key}" must be a string of at most ${MAX_METADATA_VALUE_LENGTH} characters`,
      );
    }
    parsed[key] = value;
  }
  return Object.keys(parsed).length === 0 ? EMPTY_METADATA : parsed;
}

/** Đọc metadata đã lưu trong DB (JSON hoặc null). */
export function parseStoredMetadata(raw: string | null): Metadata {
  return raw === null ? EMPTY_METADATA : (JSON.parse(raw) as Metadata);
}

export const hasMetadata = (metadata: Metadata): boolean => Object.keys(metadata).length > 0;
