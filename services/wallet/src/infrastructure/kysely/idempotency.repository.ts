import { isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { IdempotencyStore, StoredTopupResponse } from '../../application/ports.js';
import { sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async find(customerId: string, key: string): Promise<StoredTopupResponse | null> {
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('customer_id', '=', customerId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      customerId: row.customer_id,
      key: row.idempotency_key,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      topupId: row.topup_id,
      createdAt: row.created_at,
    };
  }

  async save(record: StoredTopupResponse): Promise<void> {
    try {
      await this.db
        .insertInto('idempotency_keys')
        .values({
          customer_id: record.customerId,
          idempotency_key: record.key,
          request_hash: record.requestHash,
          response_status: record.responseStatus,
          response_body: record.responseBody,
          topup_id: record.topupId,
          created_at: sqlDate(record.createdAt),
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
