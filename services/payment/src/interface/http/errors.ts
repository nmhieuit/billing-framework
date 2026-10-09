import { InvalidMoneyError } from '@billing/money';
import type { FastifyInstance } from 'fastify';
import {
  ChargeNotFoundError,
  IdempotencyConflictError,
  InvalidSettlementQueryError,
} from '../../application/errors.js';
import { InvalidChargeError } from '../../domain/errors.js';
import { InvalidScenarioError } from '../../domain/scenario.js';

export interface ErrorLogger {
  error(details: object, message?: string): void;
}

/** Lỗi đầu vào HTTP do tầng interface tự phát hiện (header/body sai dạng). */
export class RequestValidationError extends Error {
  override name = 'RequestValidationError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpError {
  status: number;
  code: string;
  message: string;
}

export function mapError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (error instanceof RequestValidationError) return { status: 400, code: error.code, message };
  if (error instanceof InvalidScenarioError)
    return { status: 400, code: 'INVALID_SIMULATE', message };
  if (error instanceof InvalidMoneyError || error instanceof InvalidChargeError) {
    return { status: 400, code: 'INVALID_REQUEST', message };
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 422, code: 'IDEMPOTENCY_KEY_REUSED', message };
  }
  if (error instanceof ChargeNotFoundError)
    return { status: 404, code: 'CHARGE_NOT_FOUND', message };
  if (error instanceof InvalidSettlementQueryError)
    return { status: 400, code: 'INVALID_QUERY', message };

  // Lỗi 4xx do chính Fastify sinh ra (JSON hỏng, body rỗng, ...).
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { status: statusCode, code: 'INVALID_REQUEST', message };
  }
  return { status: 500, code: 'INTERNAL', message: 'internal server error' };
}

export function registerErrorHandling(app: FastifyInstance, log?: ErrorLogger): void {
  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) log?.error({ err: error }, 'unhandled error');
    return reply
      .code(mapped.status)
      .send({ error: { code: mapped.code, message: mapped.message } });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `route ${request.method} ${request.url} not found` },
    }),
  );
}
