import { dateTime, isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { IdempotencyStore, StoredResponse } from '../../application/ports.js';
import type { PaymentDatabase } from './schema.js';

export class KyselyIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async find(key: string): Promise<StoredResponse | null> {
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      key: row.idempotency_key,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      chargeId: row.charge_id,
      createdAt: row.created_at,
    };
  }

  async save(record: StoredResponse): Promise<void> {
    try {
      await this.db
        .insertInto('idempotency_keys')
        .values({
          idempotency_key: record.key,
          request_hash: record.requestHash,
          response_status: record.responseStatus,
          response_body: record.responseBody,
          charge_id: record.chargeId,
          created_at: dateTime(record.createdAt) as unknown as Date,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`idempotency key already exists: ${record.key}`);
      }
      throw error;
    }
  }
}
