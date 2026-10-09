import type { Kysely } from 'kysely';
import type { Repositories, UnitOfWork } from '../../application/ports.js';
import { KyselyChargeRepository } from './charge.repository.js';
import { KyselyIdempotencyStore } from './idempotency.repository.js';
import type { PaymentDatabase } from './schema.js';
import { KyselyWebhookOutbox } from './webhook.repository.js';

/** Mỗi `run` là một transaction SQL; các repository đều gắn với transaction đó. */
export class KyselyUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) =>
      work({
        charges: new KyselyChargeRepository(trx),
        idempotency: new KyselyIdempotencyStore(trx),
        webhooks: new KyselyWebhookOutbox(trx),
      }),
    );
  }
}
