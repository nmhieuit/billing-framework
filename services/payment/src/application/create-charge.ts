import { createHash } from 'node:crypto';
import { Money, type Currency } from '@billing/money';
import { Charge } from '../domain/charge.js';
import { parseScenario } from '../domain/scenario.js';
import { DuplicateKeyError, IdempotencyConflictError } from './errors.js';
import type { Clock, IdGenerator, StoredResponse, UnitOfWork } from './ports.js';
import { toCreatedView, type ChargeCreatedView } from './views.js';

export interface CreateChargeInput {
  idempotencyKey: string;
  amount: number;
  currency: string;
  reference: string;
  simulate?: string | undefined;
}

export interface CreateChargeResult {
  status: number;
  body: ChargeCreatedView;
  replayed: boolean;
  /** Chỉ true ở lần tạo đầu tiên; lần replay luôn trả ngay để client có lối thoát. */
  responseTimeout: boolean;
}

const ACCEPTED = 202;

export class CreateCharge {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }) {}

  async execute(input: CreateChargeInput): Promise<CreateChargeResult> {
    const scenario = parseScenario(input.simulate);
    const amount = Money.of(input.amount, input.currency as Currency);
    // Băm nội dung đã chuẩn hóa: thứ tự token trong X-Simulate không làm đổi hash.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          amount: amount.amount,
          currency: amount.currency,
          reference: input.reference,
          scenario,
        }),
      )
      .digest('hex');

    const attempt = (): Promise<CreateChargeResult> =>
      this.deps.uow.run(async ({ charges, idempotency }) => {
        const existing = await idempotency.find(input.idempotencyKey);
        if (existing) return this.replay(existing, requestHash);

        const now = this.deps.clock.now();
        const charge = Charge.create({
          id: this.deps.ids.chargeId(),
          reference: input.reference,
          amount,
          scenario,
          now,
        });
        const body = toCreatedView(charge);
        await charges.insert(charge);
        await idempotency.save({
          key: input.idempotencyKey,
          requestHash,
          responseStatus: ACCEPTED,
          responseBody: JSON.stringify(body),
          chargeId: body.chargeId,
          createdAt: now,
        });
        return {
          status: ACCEPTED,
          body,
          replayed: false,
          responseTimeout: scenario.responseTimeout,
        };
      });

    try {
      return await attempt();
    } catch (error) {
      // Hai request đồng thời cùng key: bên thua vấp khóa chính; giao dịch của nó đã rollback,
      // chạy lại một lần sẽ thấy bản ghi của bên thắng và trả về replay.
      if (error instanceof DuplicateKeyError) return await attempt();
      throw error;
    }
  }

  private replay(existing: StoredResponse, requestHash: string): CreateChargeResult {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${existing.key}" was already used with different content`,
      );
    }
    return {
      status: existing.responseStatus,
      body: JSON.parse(existing.responseBody) as ChargeCreatedView,
      replayed: true,
      responseTimeout: false,
    };
  }
}
