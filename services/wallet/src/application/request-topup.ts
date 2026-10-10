import { createHash } from 'node:crypto';
import { Money } from '@billing/money';
import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { Topup } from '../domain/topup.js';
import { DuplicateKeyError, IdempotencyConflictError, WalletNotFoundError } from './errors.js';
import type {
  Clock,
  IdGenerator,
  StoredTopupResponse,
  TenantUnitOfWork,
  TopupSubmitter,
} from './ports.js';
import { toTopupCreatedView, type TopupCreatedView } from './views.js';

export interface RequestTopupInput {
  tenant: TenantId;
  customerId: CustomerId;
  idempotencyKey: string;
  amount: number;
}

export interface RequestTopupResult {
  status: 202;
  body: TopupCreatedView;
  replayed: boolean;
}

const ACCEPTED = 202;

export class RequestTopup {
  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      clock: Clock;
      ids: IdGenerator;
      submitter: TopupSubmitter;
    },
  ) {}

  async execute(input: RequestTopupInput): Promise<RequestTopupResult> {
    const attempt = (): Promise<RequestTopupResult> =>
      this.deps.uow.run(input.tenant, async ({ accounts, topups, idempotency }) => {
        const wallet = await accounts.find(Account.walletId(input.customerId));
        if (!wallet) throw new WalletNotFoundError('wallet not found');

        const amount = Money.of(input.amount, wallet.toProps().currency);
        const requestHash = createHash('sha256')
          .update(JSON.stringify({ amount: amount.amount, currency: amount.currency }))
          .digest('hex');

        const existing = await idempotency.find(input.customerId.value, input.idempotencyKey);
        if (existing) return this.replay(existing, requestHash);

        const now = this.deps.clock.now();
        const topup = Topup.request({
          id: this.deps.ids.topupId(),
          customerId: input.customerId,
          accountId: wallet.toProps().id,
          amount,
          now,
        });
        const body = toTopupCreatedView(topup);
        await topups.insert(topup);
        await idempotency.save({
          customerId: input.customerId.value,
          key: input.idempotencyKey,
          requestHash,
          responseStatus: ACCEPTED,
          responseBody: JSON.stringify(body),
          topupId: body.topupId,
          createdAt: now,
        });
        return { status: ACCEPTED, body, replayed: false };
      });

    let result: RequestTopupResult;
    try {
      result = await attempt();
    } catch (error) {
      // Hai request đồng thời cùng key: bên thua vấp khóa chính (giao dịch đã rollback);
      // chạy lại một lần sẽ thấy bản ghi của bên thắng và trả về replay.
      if (!(error instanceof DuplicateKeyError)) throw error;
      result = await attempt();
    }
    // Chỉ sau khi đã commit, và chỉ cho lần tạo mới.
    if (!result.replayed) this.deps.submitter.submitSoon(input.tenant, result.body.topupId);
    return result;
  }

  private replay(existing: StoredTopupResponse, requestHash: string): RequestTopupResult {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${existing.key}" was already used with different content`,
      );
    }
    return {
      status: ACCEPTED,
      body: JSON.parse(existing.responseBody) as TopupCreatedView,
      replayed: true,
    };
  }
}
