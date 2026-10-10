import type { Account } from '../domain/account.js';
import type { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Topup } from '../domain/topup.js';

export interface TenantRegistry {
  /** Biến chuỗi thô (header, metadata) thành `TenantId` hợp lệ và có trong cấu hình. */
  resolve(raw: string | undefined): TenantId;
  all(): readonly TenantId[];
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  topupId(): string;
  transactionId(): string;
}

export interface Logger {
  info(details: object, message?: string): void;
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface AccountRepository {
  find(id: string): Promise<Account | null>;
  /** Ném `DuplicateKeyError` nếu đã có tài khoản cùng id. */
  insert(account: Account): Promise<void>;
  /** Khóa (UPDLOCK) từng tài khoản theo thứ tự id tăng dần; trả về theo thứ tự đó; thiếu tài khoản thì ném lỗi. */
  lockMany(ids: readonly string[]): Promise<Account[]>;
  saveBalance(account: Account): Promise<void>;
}

export interface LedgerEntryRecord {
  entryId: number;
  transactionId: string;
  businessKey: string;
  amount: number;
  createdAt: Date;
}

export interface LedgerRepository {
  /** Ghi giao dịch và các dòng của nó. Ném `DuplicateKeyError` nếu `business_key` đã tồn tại. */
  post(transaction: LedgerTransaction): Promise<void>;
  /** Các dòng của một tài khoản, tăng dần theo `entryId`. */
  listEntries(query: {
    accountId: string;
    afterEntryId: number | null;
    limit: number;
  }): Promise<LedgerEntryRecord[]>;
}

export interface TopupRepository {
  insert(topup: Topup): Promise<void>;
  findById(id: string): Promise<Topup | null>;
  /** Đọc và khóa (UPDLOCK) lần nạp. */
  lockById(id: string): Promise<Topup | null>;
  /** Lần nạp `REQUESTED` đến hạn cũ nhất, khóa bằng UPDLOCK + READPAST (bỏ qua dòng đang bị khóa). */
  lockNextDue(now: Date): Promise<Topup | null>;
  save(topup: Topup): Promise<void>;
}

export interface StoredTopupResponse {
  customerId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  topupId: string;
  createdAt: Date;
}

export interface IdempotencyStore {
  find(customerId: string, key: string): Promise<StoredTopupResponse | null>;
  /** Ném `DuplicateKeyError` nếu `(customerId, key)` đã tồn tại. */
  save(record: StoredTopupResponse): Promise<void>;
}

export interface Inbox {
  /** Ghi nhận đã xử lý message; ném `DuplicateKeyError` nếu `(consumer, messageId)` đã có. */
  record(consumer: string, messageId: string, now: Date): Promise<void>;
}

export interface Repositories {
  accounts: AccountRepository;
  ledger: LedgerRepository;
  topups: TopupRepository;
  idempotency: IdempotencyStore;
  inbox: Inbox;
}

export interface TenantUnitOfWork {
  /** Một transaction SQL trên schema của tenant; không có cách truy cập DB nào mà không có `TenantId`. */
  run<T>(tenant: TenantId, work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
