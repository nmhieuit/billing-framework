import { describe, expect, it } from 'vitest';
import { InvalidOpsRequestError, validateOpsRequest } from './ops.js';

const ok = { actor: 'ops1', reason: 'fraud suspected', idempotencyKey: 'key-1' };

describe('validateOpsRequest', () => {
  it('trims whitespace', () => {
    expect(
      validateOpsRequest({ actor: '  ops1 ', reason: ' fraud ', idempotencyKey: ' key-1 ' }),
    ).toEqual({ actor: 'ops1', reason: 'fraud', idempotencyKey: 'key-1' });
  });

  it.each([
    ['actor empty', { ...ok, actor: '  ' }],
    ['actor too long', { ...ok, actor: 'a'.repeat(101) }],
    ['reason empty', { ...ok, reason: '' }],
    ['reason too long', { ...ok, reason: 'r'.repeat(501) }],
    ['key empty', { ...ok, idempotencyKey: '' }],
    ['key too long', { ...ok, idempotencyKey: 'k'.repeat(201) }],
  ])('rejects %s', (_name, input) => {
    expect(() => validateOpsRequest(input)).toThrow(InvalidOpsRequestError);
  });

  it('accepts the maximum lengths', () => {
    expect(() =>
      validateOpsRequest({
        actor: 'a'.repeat(100),
        reason: 'r'.repeat(500),
        idempotencyKey: 'k'.repeat(200),
      }),
    ).not.toThrow();
  });
});
