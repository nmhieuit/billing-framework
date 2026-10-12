import { isUniqueViolation, toSafeInteger } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { OpsActionRecord, OpsRepository } from '../../application/ports.js';
import type { OpsActionKind } from '../../domain/ops.js';
import { sqlDate } from './mappers.js';
import type { OpsActionsTable, WalletDatabase } from './schema.js';

export class KyselyOpsRepository implements OpsRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async lockKey(idempotencyKey: string): Promise<void> {
    // Khóa ứng dụng mức transaction (nhả khi commit/rollback). Tài nguyên gồm schema nên khóa chỉ có nghĩa trong một tenant;
    // tối đa 4 + 42 + 1 + 200 ký tự, dưới giới hạn 255 của sp_getapplock.
    const resource = `ops:${this.schema}:${idempotencyKey}`;
    const result = await sql<{ code: number }>`
      declare @code int;
      exec @code = sp_getapplock @Resource = ${resource}, @LockMode = 'Exclusive',
        @LockOwner = 'Transaction', @LockTimeout = 10000;
      select @code as code`.execute(this.db);
    const code = result.rows[0]?.code;
    if (typeof code !== 'number' || code < 0) {
      throw new Error(
        `could not acquire the ops idempotency lock (sp_getapplock returned ${String(code)})`,
      );
    }
  }

  async find(idempotencyKey: string): Promise<OpsActionRecord | null> {
    const row = await this.db
      .selectFrom('ops_actions')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async insert(record: OpsActionRecord): Promise<void> {
    try {
      await this.db
        .insertInto('ops_actions')
        .values({
          id: record.id,
          action: record.action,
          actor: record.actor,
          reason: record.reason,
          target: record.target,
          idempotency_key: record.idempotencyKey,
          fingerprint: record.fingerprint,
          result: record.result,
          created_at: sqlDate(record.createdAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(
          `ops action already recorded: ${record.idempotencyKey}`,
          'ops_action',
        );
      }
      throw error;
    }
  }

  async list(query: { limit: number; beforeSeq: number | null }): Promise<OpsActionRecord[]> {
    let builder = this.db.selectFrom('ops_actions').selectAll();
    if (query.beforeSeq !== null) {
      builder = builder.where('seq', '<', String(query.beforeSeq));
    }
    const rows = await builder.orderBy('seq', 'desc').top(query.limit).execute();
    return rows.map(toRecord);
  }
}

function toRecord(row: Selectable<OpsActionsTable>): OpsActionRecord {
  return {
    id: row.id,
    action: row.action as OpsActionKind,
    actor: row.actor,
    reason: row.reason,
    target: row.target,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    result: row.result,
    createdAt: row.created_at,
    seq: toSafeInteger(row.seq),
  };
}
