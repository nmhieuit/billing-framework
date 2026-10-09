import { ChargeNotFoundError } from './errors.js';
import type { UnitOfWork } from './ports.js';
import { toChargeView, type ChargeView } from './views.js';

export class GetCharge {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  async execute(id: string): Promise<ChargeView> {
    const charge = await this.deps.uow.run(({ charges }) => charges.findById(id));
    if (!charge) throw new ChargeNotFoundError(`charge ${id} not found`);
    return toChargeView(charge);
  }
}
