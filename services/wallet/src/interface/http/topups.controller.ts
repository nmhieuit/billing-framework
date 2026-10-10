import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { GetTopup } from '../../application/get-topup.js';
import type { RequestTopup } from '../../application/request-topup.js';
import { CallerGuard, CurrentCaller, type Caller } from './caller.guard.js';
import { ApiError } from './errors.js';
import { GET_TOPUP, REQUEST_TOPUP } from './tokens.js';

const MAX_KEY_LENGTH = 255;

function readIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
  if (raw.length > MAX_KEY_LENGTH || raw !== raw.trim()) {
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      `Idempotency-Key must be 1..${MAX_KEY_LENGTH} characters without leading or trailing whitespace`,
    );
  }
  return raw;
}

@Controller()
@UseGuards(CallerGuard)
export class TopupsController {
  constructor(
    @Inject(REQUEST_TOPUP) private readonly requestTopup: Pick<RequestTopup, 'execute'>,
    @Inject(GET_TOPUP) private readonly getTopup: Pick<GetTopup, 'execute'>,
  ) {}

  @Post('topups')
  @HttpCode(202)
  async create(
    @CurrentCaller() caller: Caller,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() body: unknown,
  ) {
    const idempotencyKey = readIdempotencyKey(rawKey);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
    }
    const { amount } = body as { amount?: unknown };
    if (typeof amount !== 'number') {
      throw new ApiError(400, 'INVALID_REQUEST', 'amount must be a number');
    }
    const result = await this.requestTopup.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      idempotencyKey,
      amount,
    });
    return result.body;
  }

  @Get('topups/:id')
  get(@CurrentCaller() caller: Caller, @Param('id') id: string) {
    return this.getTopup.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      topupId: id,
    });
  }
}
