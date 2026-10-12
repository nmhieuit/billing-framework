import { isUniqueViolation, toSafeInteger } from '@billing/database';
import type { Kysely, Selectable } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { OpsActionRecord, OpsRepository } from '../../application/ports.js';
import type { OpsActionKind } from '../../domain/ops.js';
import { sqlDate } from './mappers.js';
import type { OpsActionsTable, WalletDatabase } from './schema.js';

export class KyselyOpsRepository implements OpsRepository {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

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
