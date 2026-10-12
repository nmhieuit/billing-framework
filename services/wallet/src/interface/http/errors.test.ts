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

  it('lets a ledger construction error fall through to 500 INTERNAL (ops inputs are validated before the ledger is built)', () => {
    expect(mapError(new InvalidLedgerTransactionError('entries must sum to zero'))).toEqual({
      status: 500,
      code: 'INTERNAL',
      message: 'internal error',
    });
  });

  it('answers fixed messages that do not echo internal account ids', () => {
    expect(
      mapError(new InsufficientFundsError('insufficient funds in wallet:c1 (balance 5)')),
    ).toEqual({
      status: 409,
      code: 'INSUFFICIENT_FUNDS',
      message: 'wallet balance is insufficient',
    });
    expect(
      mapError(
        new ReversalNotPossibleError('reversal would break the balance of system:MERCHANT:VND'),
      ),
    ).toEqual({
      status: 409,
      code: 'REVERSAL_NOT_POSSIBLE',
      message: 'reversal would break a system account balance',
    });
  });
});
