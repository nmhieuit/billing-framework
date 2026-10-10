import { sql } from 'kysely';
import { ApplyPaymentResult } from './application/apply-payment-result.js';
import { ReconciliationTooLargeError } from './application/errors.js';
import type { SettlementSource } from './application/ports.js';
import type { GatewayCharge } from './domain/reconciliation.js';
import { seedTopup, silentLogger, type Harness, type SeededTopup } from './test-support.js';

/** Sao kê giả: trả charge đã đặt theo ngày, hoặc ném lỗi đã chọn. */
export class FakeSettlement implements SettlementSource {
  readonly calls: string[] = [];
  failWith: Error | undefined;
  readonly #days = new Map<string, GatewayCharge[]>();

  set(day: string, charges: GatewayCharge[]): this {
    this.#days.set(day, charges);
    return this;
  }

  async fetchDay(day: string, maxCharges: number): Promise<GatewayCharge[]> {
    this.calls.push(day);
    if (this.failWith) throw this.failWith;
    const charges = this.#days.get(day) ?? [];
    if (charges.length > maxCharges) {
      throw new ReconciliationTooLargeError(
        `settlement for ${day} has more than ${maxCharges} charges`,
      );
    }
    return charges;
  }
}

/** Charge SUCCEEDED khớp hoàn toàn với lần nạp đã dựng; ghi đè từng trường để tạo lệch. */
export const chargeFor = (
  seeded: SeededTopup,
  overrides: Partial<GatewayCharge> = {},
): GatewayCharge => ({
  chargeId: seeded.chargeId,
  reference: seeded.topupId,
  amount: seeded.amount,
  currency: seeded.currency,
  status: 'SUCCEEDED',
  tenantId: seeded.tenant.value,
  ...overrides,
});

/** Lần nạp đã SUCCEEDED thật (qua `ApplyPaymentResult`), số dư ví đã được cộng. */
export async function seedSucceededTopup(
  h: Harness,
  options: Parameters<typeof seedTopup>[1] = {},
): Promise<SeededTopup> {
  const seeded = await seedTopup(h, { ...options, state: 'PENDING' });
  const outcome = await new ApplyPaymentResult({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
  }).execute({
    tenant: seeded.tenant,
    eventId: `evt_seed_${seeded.topupId}`,
    type: 'charge.succeeded',
    chargeId: seeded.chargeId,
    reference: seeded.topupId,
    amount: seeded.amount,
    currency: seeded.currency,
  });
  if (outcome !== 'APPLIED') throw new Error(`could not settle seeded topup: ${outcome}`);
  return seeded;
}

let dayCounter = 0;

/** Mỗi test một ngày riêng (các test dùng chung database) và đặt đồng hồ vào 10:00 UTC của ngày đó. */
export function startDay(h: Harness): string {
  const day = new Date(Date.UTC(2027, 0, 1 + ++dayCounter)).toISOString().slice(0, 10);
  h.clock.set(`${day}T10:00:00.000Z`);
  return day;
}

/**
 * Phá sổ cái của tenant acme để kiểm tra đối soát: thêm một giao dịch lệch (+7 vào MERCHANT)
 * và làm số dư ví lệch +5. Trigger chỉ chặn update/delete nên insert được.
 */
export async function tamperLedger(h: Harness, walletId: string): Promise<void> {
  await sql`insert into ${sql.id('t_acme', 'ledger_transactions')} (id, business_key, kind, created_at)
    values ('tx_bad', 'bad:1', 'TOPUP', cast(sysutcdatetime() as datetime2(3)))`.execute(h.db);
  await sql`insert into ${sql.id('t_acme', 'ledger_entries')} (transaction_id, account_id, amount, created_at)
    values ('tx_bad', 'system:MERCHANT:VND', 7, cast(sysutcdatetime() as datetime2(3)))`.execute(
    h.db,
  );
  await sql`update ${sql.id('t_acme', 'accounts')} set balance = balance + 5 where id = ${walletId}`.execute(
    h.db,
  );
}
