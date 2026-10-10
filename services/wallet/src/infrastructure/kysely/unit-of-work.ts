import type { Kysely } from 'kysely';
import type { Repositories, TenantUnitOfWork } from '../../application/ports.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { KyselyAccountRepository } from './account.repository.js';
import { KyselyIdempotencyStore } from './idempotency.repository.js';
import { KyselyInbox } from './inbox.repository.js';
import { KyselyLedgerRepository } from './ledger.repository.js';
import { KyselyOrderPaymentRepository } from './order-payment.repository.js';
import { KyselyOutboxRepository } from './outbox.repository.js';
import { KyselyReconciliationRepository } from './reconciliation.repository.js';
import type { WalletDatabase } from './schema.js';
import { assertSchemaName, schemaName } from './schema-name.js';
import { KyselyTopupRepository } from './topup.repository.js';

/** Mỗi `run` là một transaction SQL; mọi repository gắn với schema của tenant được truyền vào. */
export class KyselyTenantUnitOfWork implements TenantUnitOfWork {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  run<T>(tenant: TenantId, work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const schema = assertSchemaName(schemaName(tenant));
    return this.db.transaction().execute((trx) => {
      const scoped = trx.withSchema(schema);
      return work({
        accounts: new KyselyAccountRepository(scoped, schema),
        ledger: new KyselyLedgerRepository(scoped),
        topups: new KyselyTopupRepository(scoped, schema),
        idempotency: new KyselyIdempotencyStore(scoped),
        inbox: new KyselyInbox(scoped),
        orderPayments: new KyselyOrderPaymentRepository(scoped),
        outbox: new KyselyOutboxRepository(scoped, schema),
        reconciliation: new KyselyReconciliationRepository(scoped, schema),
      });
    });
  }
}
