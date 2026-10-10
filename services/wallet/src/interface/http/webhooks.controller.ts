import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { validateChargeWebhook, verifyWebhook } from '@billing/contracts';
import type { FastifyRequest } from 'fastify';
import type { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import type { Clock, TenantRegistry } from '../../application/ports.js';
import { ApiError } from './errors.js';
import { APPLY_PAYMENT_RESULT, CLOCK, TENANT_REGISTRY, WEBHOOK_SECRET } from './tokens.js';

@Controller()
export class WebhooksController {
  constructor(
    @Inject(APPLY_PAYMENT_RESULT)
    private readonly applyPaymentResult: Pick<ApplyPaymentResult, 'execute'>,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SECRET) private readonly secret: string,
  ) {}

  /**
   * Thứ tự cố định: (1) chữ ký trên THÂN THÔ, (2) hình dạng payload, (3) tenant lấy từ payload ĐÃ KÝ,
   * (4) use case. Không bao giờ ghi hay trả lại chữ ký hoặc bí mật.
   */
  @Post('webhooks/payment')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('x-signature') signature: string | undefined,
  ) {
    const raw = request.rawBody?.toString('utf8') ?? '';
    const verdict = verifyWebhook({
      secret: this.secret,
      body: raw,
      header: signature,
      nowSeconds: Math.floor(this.clock.now().getTime() / 1000),
    });
    if (!verdict.ok) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'webhook signature is invalid');
    }

    const parsed = validateChargeWebhook(request.body);
    if (!parsed.ok) {
      throw new ApiError(
        400,
        'INVALID_WEBHOOK',
        `webhook payload is invalid: ${parsed.errors.join('; ')}`,
      );
    }
    const { payload } = parsed;

    let tenant;
    try {
      tenant = this.registry.resolve(payload.data.metadata?.tenantId);
    } catch (error) {
      if (error instanceof MissingTenantError || error instanceof UnknownTenantError) {
        throw new ApiError(400, 'INVALID_WEBHOOK', 'webhook does not identify a known tenant');
      }
      throw error;
    }

    const outcome = await this.applyPaymentResult.execute({
      tenant,
      eventId: payload.eventId,
      type: payload.type,
      chargeId: payload.data.chargeId,
      reference: payload.data.reference,
      amount: payload.data.amount,
      currency: payload.data.currency,
      failureCode: payload.data.failureCode,
    });
    return { outcome };
  }
}
