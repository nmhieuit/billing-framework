import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { InvalidQueryError, WalletNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toEntryView, type EntryView } from './views.js';

export const DEFAULT_ENTRIES_LIMIT = 100;
export const MAX_ENTRIES_LIMIT = 1000;
const CURSOR = /^\d{1,18}$/;

export interface ListEntriesInput {
  tenant: TenantId;
  customerId: CustomerId;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListEntriesResult {
  items: EntryView[];
  nextCursor: string | null;
}

export class ListEntries {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: ListEntriesInput): Promise<ListEntriesResult> {
    const limit = input.limit ?? DEFAULT_ENTRIES_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ENTRIES_LIMIT) {
      throw new InvalidQueryError(`limit must be an integer in 1..${MAX_ENTRIES_LIMIT}`);
    }
    let afterEntryId: number | null = null;
    if (input.cursor !== undefined) {
      if (!CURSOR.test(input.cursor)) throw new InvalidQueryError('cursor is invalid');
      afterEntryId = Number(input.cursor);
    }

    const accountId = Account.walletId(input.customerId);
    const records = await this.deps.uow.run(input.tenant, async ({ accounts, ledger }) => {
      if (!(await accounts.find(accountId))) throw new WalletNotFoundError('wallet not found');
      // Lấy dư một dòng để biết còn trang sau hay không.
      return ledger.listEntries({ accountId, afterEntryId, limit: limit + 1 });
    });

    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toEntryView),
      nextCursor: records.length > limit && last ? String(last.entryId) : null,
    };
  }
}
