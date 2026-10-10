import { isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { Inbox } from '../../application/ports.js';
import { sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyInbox implements Inbox {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async record(consumer: string, messageId: string, now: Date): Promise<void> {
    try {
      await this.db
        .insertInto('processed_messages')
        .values({ consumer, message_id: messageId, processed_at: sqlDate(now) })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`message already processed: ${consumer}/${messageId}`, 'inbox');
      }
      throw error;
    }
  }
}
