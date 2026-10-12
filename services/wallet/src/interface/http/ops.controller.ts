import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AdjustWallet } from '../../application/adjust-wallet.js';
import { InvalidQueryError } from '../../application/errors.js';
import type { FreezeWallet } from '../../application/freeze-wallet.js';
import type { ListOpsActions } from '../../application/list-ops-actions.js';
import type { ReplayOrderPaid } from '../../application/replay-order-paid.js';
import type { ReverseTransaction } from '../../application/reverse-transaction.js';
import { bodyObject, text } from './body.js';
import { CurrentOps, OpsGuard, type OpsContext } from './ops.guard.js';
import {
  ADJUST_WALLET,
  FREEZE_WALLET,
  LIST_OPS_ACTIONS,
  REPLAY_ORDER_PAID,
  REVERSE_TRANSACTION,
} from './tokens.js';

/** Phần chung của mọi yêu cầu ops; `actor` luôn từ header qua OpsGuard, bỏ qua mọi `actor` trong body. */
function common(ops: OpsContext, fields: Record<string, unknown>) {
  return {
    tenant: ops.tenant,
    actor: ops.actor,
    reason: text(fields.reason),
    idempotencyKey: text(fields.idempotencyKey),
  };
}

/** Controller mỏng: chỉ ánh xạ tham số sang use case. */
@Controller('ops')
@UseGuards(OpsGuard)
export class OpsController {
  constructor(
    @Inject(FREEZE_WALLET) private readonly freezeWallet: Pick<FreezeWallet, 'execute'>,
    @Inject(ADJUST_WALLET) private readonly adjustWallet: Pick<AdjustWallet, 'execute'>,
    @Inject(REVERSE_TRANSACTION)
    private readonly reverseTransaction: Pick<ReverseTransaction, 'execute'>,
    @Inject(REPLAY_ORDER_PAID) private readonly replayOrderPaid: Pick<ReplayOrderPaid, 'execute'>,
    @Inject(LIST_OPS_ACTIONS) private readonly listOpsActions: Pick<ListOpsActions, 'execute'>,
  ) {}

  @Post('wallets/:customerId/freeze')
  @HttpCode(200)
  freeze(
    @CurrentOps() ops: OpsContext,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    return this.freezeWallet.execute({
      ...common(ops, bodyObject(body)),
      customerId,
      frozen: true,
    });
  }

  @Post('wallets/:customerId/unfreeze')
  @HttpCode(200)
  unfreeze(
    @CurrentOps() ops: OpsContext,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    return this.freezeWallet.execute({
      ...common(ops, bodyObject(body)),
      customerId,
      frozen: false,
    });
  }

  @Post('wallets/:customerId/adjustments')
  @HttpCode(201)
  adjust(
    @CurrentOps() ops: OpsContext,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    const fields = bodyObject(body);
    return this.adjustWallet.execute({
      ...common(ops, fields),
      customerId,
      direction: text(fields.direction),
      // Không phải số -> NaN để use case từ chối bằng 422.
      amount: typeof fields.amount === 'number' ? fields.amount : Number.NaN,
      currency: text(fields.currency),
    });
  }

  @Post('transactions/:id/reversals')
  @HttpCode(201)
  reverse(@CurrentOps() ops: OpsContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reverseTransaction.execute({
      ...common(ops, bodyObject(body)),
      transactionId: id,
    });
  }

  @Post('orders/:orderId/replay-paid')
  @HttpCode(202)
  replay(@CurrentOps() ops: OpsContext, @Param('orderId') orderId: string, @Body() body: unknown) {
    return this.replayOrderPaid.execute({ ...common(ops, bodyObject(body)), orderId });
  }

  @Get('actions')
  actions(
    @CurrentOps() ops: OpsContext,
    @Query('limit') limit?: string | string[],
    @Query('cursor') cursor?: string | string[],
  ) {
    if (Array.isArray(limit) || Array.isArray(cursor)) {
      throw new InvalidQueryError('limit and cursor must each be given at most once');
    }
    return this.listOpsActions.execute({
      tenant: ops.tenant,
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
    });
  }
}
