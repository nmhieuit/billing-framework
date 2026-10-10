import { Body, Controller, Get, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { CreateWallet } from '../../application/create-wallet.js';
import { InvalidQueryError } from '../../application/errors.js';
import type { GetWallet } from '../../application/get-wallet.js';
import type { ListEntries } from '../../application/list-entries.js';
import { CallerGuard, CurrentCaller, type Caller } from './caller.guard.js';
import { ApiError } from './errors.js';
import { CREATE_WALLET, GET_WALLET, LIST_ENTRIES } from './tokens.js';

@Controller()
@UseGuards(CallerGuard)
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: Pick<CreateWallet, 'execute'>,
    @Inject(GET_WALLET) private readonly getWallet: Pick<GetWallet, 'execute'>,
    @Inject(LIST_ENTRIES) private readonly listEntries: Pick<ListEntries, 'execute'>,
  ) {}

  @Post('wallets')
  async create(
    @CurrentCaller() caller: Caller,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
    }
    const { currency } = body as { currency?: unknown };
    if (typeof currency !== 'string') {
      throw new ApiError(400, 'INVALID_REQUEST', 'currency must be a string');
    }
    const { created, wallet } = await this.createWallet.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      currency,
    });
    void reply.code(created ? 201 : 200);
    return wallet;
  }

  @Get('wallet')
  get(@CurrentCaller() caller: Caller) {
    return this.getWallet.execute({ tenant: caller.tenant, customerId: caller.customerId });
  }

  @Get('wallet/entries')
  entries(
    @CurrentCaller() caller: Caller,
    @Query('limit') limit?: string | string[],
    @Query('cursor') cursor?: string | string[],
  ) {
    if (Array.isArray(limit) || Array.isArray(cursor)) {
      throw new InvalidQueryError('limit and cursor must each be given at most once');
    }
    return this.listEntries.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
    });
  }
}
