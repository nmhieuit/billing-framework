import { dateTime, toSafeInteger } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  ChargeRepository,
  CompletedCursor,
  SettlementTotal,
} from '../../application/ports.js';
import type { Charge } from '../../domain/charge.js';
import { chargeToRow, rowToCharge } from './mappers.js';
import type { ChargesTable, PaymentDatabase } from './schema.js';

export class KyselyChargeRepository implements ChargeRepository {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async insert(charge: Charge): Promise<void> {
    await this.db.insertInto('charges').values(chargeToRow(charge)).execute();
  }

  async findById(id: string): Promise<Charge | null> {
    const row = await this.db
      .selectFrom('charges')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToCharge(row) : null;
  }

  async lockDue(now: Date, limit: number): Promise<Charge[]> {
    // Cần index ix_charges_due (status, due_at, id): không có nó READPAST không bỏ qua được hàng nào có ích.
    const result = await sql<Selectable<ChargesTable>>`
      select top (${limit}) id, reference, amount, currency, status, failure_code, scenario,
             due_at, created_at, completed_at
      from charges with (updlock, readpast, rowlock)
      where status = ${'PENDING'} and due_at <= ${dateTime(now)}
      order by due_at, id`.execute(this.db);
    return result.rows.map(rowToCharge);
  }

  async save(charge: Charge): Promise<void> {
    const row = chargeToRow(charge);
    await this.db
      .updateTable('charges')
      .set({
        status: row.status,
        failure_code: row.failure_code ?? null,
        completed_at: row.completed_at ?? null,
      })
      .where('id', '=', row.id)
      .execute();
  }

  async listCompleted(query: {
    from: Date;
    to: Date;
    limit: number;
    after: CompletedCursor | null;
  }): Promise<Charge[]> {
    let builder = this.db
      .selectFrom('charges')
      .selectAll()
      .where('completed_at', '>=', dateTime(query.from))
      .where('completed_at', '<', dateTime(query.to));
    if (query.after) {
      const at = dateTime(query.after.completedAt);
      const afterId = query.after.id;
      builder = builder.where((eb) =>
        eb.or([
          eb('completed_at', '>', at),
          eb.and([eb('completed_at', '=', at), eb('id', '>', afterId)]),
        ]),
      );
    }
    const rows = await builder.orderBy('completed_at').orderBy('id').top(query.limit).execute();
    return rows.map(rowToCharge);
  }

  async totals(range: { from: Date; to: Date }): Promise<SettlementTotal[]> {
    const rows = await this.db
      .selectFrom('charges')
      .select([
        'currency',
        'status',
        (eb) => eb.fn.countAll().as('count'),
        (eb) => eb.fn.sum('amount').as('total'),
      ])
      .where('completed_at', '>=', dateTime(range.from))
      .where('completed_at', '<', dateTime(range.to))
      .groupBy(['currency', 'status'])
      .orderBy('currency')
      .orderBy('status')
      .execute();
    return rows.map((row) => ({
      currency: row.currency,
      status: row.status as SettlementTotal['status'],
      count: toSafeInteger(row.count),
      totalAmount: toSafeInteger(row.total),
    }));
  }
}
