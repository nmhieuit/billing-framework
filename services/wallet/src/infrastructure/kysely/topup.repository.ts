import { dateTime } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { TopupRepository } from '../../application/ports.js';
import type { Topup } from '../../domain/topup.js';
import { rowToTopup, topupToRow } from './mappers.js';
import type { TopupsTable, WalletDatabase } from './schema.js';

const COLUMNS = sql.raw(
  'id, customer_id, account_id, amount, currency, status, charge_id, failure_code, attempts, next_attempt_at, created_at, completed_at',
);

export class KyselyTopupRepository implements TopupRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async insert(topup: Topup): Promise<void> {
    await this.db.insertInto('topups').values(topupToRow(topup)).execute();
  }

  async findById(id: string): Promise<Topup | null> {
    const row = await this.db
      .selectFrom('topups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToTopup(row) : null;
  }

  async lockById(id: string): Promise<Topup | null> {
    const result = await sql<Selectable<TopupsTable>>`
      select ${COLUMNS} from ${sql.id(this.schema, 'topups')} with (updlock, rowlock)
      where id = ${id}`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToTopup(row) : null;
  }

  async lockNextDue(now: Date): Promise<Topup | null> {
    // Cần index ix_topups_due (status, next_attempt_at, id) khớp ORDER BY để READPAST bỏ qua đúng dòng bị khóa.
    const result = await sql<Selectable<TopupsTable>>`
      select top (1) ${COLUMNS}
      from ${sql.id(this.schema, 'topups')} with (updlock, readpast, rowlock)
      where status = ${'REQUESTED'} and next_attempt_at <= ${dateTime(now)}
      order by next_attempt_at, id`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToTopup(row) : null;
  }

  async save(topup: Topup): Promise<void> {
    const row = topupToRow(topup);
    await this.db
      .updateTable('topups')
      .set({
        status: row.status,
        charge_id: row.charge_id ?? null,
        failure_code: row.failure_code ?? null,
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at ?? null,
        completed_at: row.completed_at ?? null,
      })
      .where('id', '=', row.id)
      .execute();
  }
}
