import { ApiError } from './errors.js';

/** Thân yêu cầu phải là một đối tượng JSON; mảng, null hay giá trị đơn lẻ bị từ chối bằng 400. */
export function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Trường không phải chuỗi coi như rỗng để use case từ chối bằng 422 (không phải 400). */
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
