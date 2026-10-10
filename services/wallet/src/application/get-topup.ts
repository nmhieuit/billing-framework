import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { TopupNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toTopupView, type TopupView } from './views.js';

export class GetTopup {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: {
    tenant: TenantId;
    customerId: CustomerId;
    topupId: string;
  }): Promise<TopupView> {
    const topup = await this.deps.uow.run(input.tenant, ({ topups }) =>
      topups.findById(input.topupId),
    );
    // Lần nạp của khách khác bị che giấu bằng cùng một lỗi với id không tồn tại.
    if (!topup || topup.toProps().customerId !== input.customerId.value) {
      throw new TopupNotFoundError('topup not found');
    }
    return toTopupView(topup);
  }
}
