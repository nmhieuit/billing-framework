import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { InvalidMoneyError } from '@billing/money';
import type { FastifyReply } from 'fastify';
import {
  IdempotencyConflictError,
  InvalidQueryError,
  MissingCustomerError,
  MissingTenantError,
  TopupNotFoundError,
  UnknownTenantError,
  WalletCurrencyConflictError,
  WalletNotFoundError,
} from '../../application/errors.js';
import type { Logger } from '../../application/ports.js';
import { InvalidCustomerError, InvalidTopupError } from '../../domain/errors.js';
import { LOGGER } from './tokens.js';

/** Lỗi do chính lớp HTTP phát hiện (thiếu/sai header hay body) trước khi vào use case. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

const RULES: ReadonlyArray<{ matches: (error: unknown) => boolean; status: number; code: string }> =
  [
    { matches: (e) => e instanceof MissingTenantError, status: 400, code: 'MISSING_TENANT' },
    { matches: (e) => e instanceof UnknownTenantError, status: 403, code: 'UNKNOWN_TENANT' },
    { matches: (e) => e instanceof MissingCustomerError, status: 400, code: 'MISSING_CUSTOMER' },
    {
      matches: (e) =>
        e instanceof InvalidCustomerError ||
        e instanceof InvalidMoneyError ||
        e instanceof InvalidTopupError,
      status: 400,
      code: 'INVALID_REQUEST',
    },
    { matches: (e) => e instanceof InvalidQueryError, status: 400, code: 'INVALID_QUERY' },
    { matches: (e) => e instanceof WalletNotFoundError, status: 404, code: 'WALLET_NOT_FOUND' },
    { matches: (e) => e instanceof TopupNotFoundError, status: 404, code: 'TOPUP_NOT_FOUND' },
    {
      matches: (e) => e instanceof WalletCurrencyConflictError,
      status: 409,
      code: 'WALLET_CURRENCY_CONFLICT',
    },
    {
      matches: (e) => e instanceof IdempotencyConflictError,
      status: 422,
      code: 'IDEMPOTENCY_KEY_REUSED',
    },
  ];

const STATUS_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

function clientStatus(error: unknown): number | undefined {
  if (error instanceof HttpException) return error.getStatus();
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/** Thuần túy và có thể kiểm thử riêng: lỗi nào thành mã HTTP và mã lỗi nào. */
export function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  for (const rule of RULES) {
    if (rule.matches(error)) {
      return { status: rule.status, code: rule.code, message: (error as Error).message };
    }
  }
  const status = clientStatus(error);
  if (status !== undefined && status < 500) {
    return {
      status,
      code: STATUS_CODES[status] ?? `HTTP_${status}`,
      message: error instanceof Error ? error.message : 'request failed',
    };
  }
  return { status: 500, code: 'INTERNAL', message: 'internal error' };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const mapped = mapError(error);
    if (mapped.status >= 500) this.log.error({ err: error }, 'unhandled error');
    void reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
  }
}
