import { describe, expect, it } from 'vitest';
import {
  AlreadyReversedError,
  EventIdUnknownError,
  OpsIdempotencyConflictError,
  OrderNotFoundError,
  OrderReversedError,
  ReversalNotPossibleError,
  ReversalNotSupportedError,
  TransactionNotFoundError,
} from '../../application/errors.js';
import { InsufficientFundsError, InvalidLedgerTransactionError } from '../../domain/errors.js';
import { InvalidOpsRequestError } from '../../domain/ops.js';
import { mapError } from './errors.js';

describe('mapError (ops)', () => {
  it.each([
    [new InvalidOpsRequestError('x'), 422, 'INVALID_OPS_REQUEST'],
    [new InvalidLedgerTransactionError('x'), 422, 'INVALID_OPS_REQUEST'],
    [new OpsIdempotencyConflictError('x'), 409, 'IDEMPOTENCY_CONFLICT'],
    [new TransactionNotFoundError('x'), 404, 'TRANSACTION_NOT_FOUND'],
    [new OrderNotFoundError('x'), 404, 'ORDER_NOT_FOUND'],
    [new AlreadyReversedError('x'), 409, 'ALREADY_REVERSED'],
    [new ReversalNotSupportedError('x'), 409, 'REVERSAL_NOT_SUPPORTED'],
    [new ReversalNotPossibleError('x'), 409, 'REVERSAL_NOT_POSSIBLE'],
    [new OrderReversedError('x'), 409, 'ORDER_REVERSED'],
    [new EventIdUnknownError('x'), 409, 'EVENT_ID_UNKNOWN'],
    [new InsufficientFundsError('x'), 409, 'INSUFFICIENT_FUNDS'],
  ])('maps %o to %i %s', (error, status, code) => {
    expect(mapError(error)).toMatchObject({ status, code });
  });
});
