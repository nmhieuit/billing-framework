import type { Money } from '@billing/money';
import type { Account } from '../domain/account.js';
import type { LedgerTransaction } from '../domain/ledger-transaction.js';
import type {
  AutofixAction,
  CaseStatus,
  GatewayCharge,
  ReconciliationKind,
  WalletTopupView,
} from '../domain/reconciliation.js';
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
  /** UUID thật: các schema event yêu cầu `eventId` là UUID. */
  eventId(): string;
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
  orderPayments: OrderPaymentRepository;
  outbox: OutboxRepository;
  reconciliation: ReconciliationRepository;
}

export interface TenantUnitOfWork {
  /** Một transaction SQL trên schema của tenant; không có cách truy cập DB nào mà không có `TenantId`. */
  run<T>(tenant: TenantId, work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export interface TopupSubmitter {
  /** Kích hoạt một lần thử gửi lần nạp sang payment và trả về ngay (không chờ). Bên cài đặt tự xử lý lỗi. */
  submitSoon(tenant: TenantId, topupId: string): void;
}

export interface GatewayChargeRequest {
  idempotencyKey: string;
  amount: Money;
  reference: string;
  metadata: Record<string, string>;
}

export type GatewayChargeResult =
  | { kind: 'created'; chargeId: string }
  | { kind: 'rejected'; status: number; message: string }
  | { kind: 'unavailable'; error: string };

export interface PaymentGateway {
  /** Không bao giờ ném: mọi lỗi được trả về dưới dạng `rejected` (đừng thử lại) hoặc `unavailable` (thử lại sau). */
  createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult>;
}

/** Đơn đã được trả từ ví; khóa theo `orderId` để một đơn chỉ trả một lần. */
export interface PaidOrder {
  orderId: string;
  customerId: string;
  walletTransactionId: string;
  amount: Money;
  paidAt: Date;
}

export interface OrderPaymentRepository {
  find(orderId: string): Promise<PaidOrder | null>;
  /** Ném `DuplicateKeyError` (nguồn `order_payment`) nếu đơn đã được trả. */
  insert(order: PaidOrder): Promise<void>;
}

export interface NewOutboxMessage {
  id: string;
  eventType: string;
  routingKey: string;
  payload: string;
  correlationId: string;
  createdAt: Date;
}

export interface OutboxMessage extends NewOutboxMessage {
  attempts: number;
  nextAttemptAt: Date;
}

export interface OutboxRepository {
  /** Thêm message `PENDING`, `attempts` 0, đến hạn ngay tại `createdAt`. */
  add(message: NewOutboxMessage): Promise<void>;
  /** Message `PENDING` đến hạn cũ nhất, khóa bằng UPDLOCK + READPAST (bỏ qua dòng đang bị khóa). */
  lockNextDue(now: Date): Promise<OutboxMessage | null>;
  /** Đẩy `next_attempt_at` ra xa để không ai nhận lại message trong lúc đang gửi. */
  lease(id: string, until: Date): Promise<void>;
  markSent(id: string, sentAt: Date): Promise<void>;
  /** Tăng `attempts` và đặt lịch gửi lại. */
  recordFailure(id: string, nextAttemptAt: Date): Promise<void>;
}

export type PublishOutcome =
  { kind: 'delivered' } | { kind: 'unroutable' } | { kind: 'failed'; error: string };

export interface EventPublisher {
  /** Không bao giờ ném: mọi lỗi trả về dưới dạng `unroutable` hoặc `failed`. */
  publish(message: OutboxMessage): Promise<PublishOutcome>;
}

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type RunTrigger = 'SCHEDULED' | 'MANUAL';

export interface ReconciliationRun {
  id: string;
  day: string;
  status: RunStatus;
  triggeredBy: RunTrigger;
  failureReason: string | null;
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
  itemCount: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface NewReconciliationItem {
  id: string;
  kind: ReconciliationKind;
  chargeId: string | null;
  topupId: string | null;
  amountGateway: number | null;
  amountWallet: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  action: AutofixAction;
}

export interface ReconciliationItem extends NewReconciliationItem {
  /** Số thứ tự tăng dần toàn schema; dùng làm cursor phân trang. */
  seq: number;
  runId: string;
  caseStatus: CaseStatus;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface ReconciliationRepository {
  /** `false` khi lượt `SCHEDULED` của ngày này đã có (đang chạy hoặc đã xong): không tạo lượt trùng. */
  startRun(run: {
    id: string;
    day: string;
    triggeredBy: RunTrigger;
    startedAt: Date;
  }): Promise<boolean>;
  /** Ghi các dòng lệch và đóng lượt `COMPLETED`. Dòng `AUTO_APPLIED` được ghi sẵn ở trạng thái `RESOLVED` bởi `system`. */
  completeRun(
    id: string,
    input: {
      gatewayTotals: Record<string, number>;
      walletTotals: Record<string, number>;
      items: readonly NewReconciliationItem[];
      finishedAt: Date;
    },
  ): Promise<void>;
  failRun(id: string, reason: string, finishedAt: Date): Promise<void>;
  /** Đánh dấu `FAILED` các lượt còn `RUNNING` bắt đầu trước `startedBefore`; trả về số lượt bị đóng. */
  failStaleRuns(startedBefore: Date, reason: string, now: Date): Promise<number>;
  findRun(id: string): Promise<ReconciliationRun | null>;
  /** Số lượt định kỳ của ngày theo trạng thái, và lúc lượt `FAILED` gần nhất kết thúc. */
  scheduledRunsFor(day: string): Promise<{
    running: number;
    completed: number;
    failed: number;
    lastFailedAt: Date | null;
  }>;
  listItems(query: {
    runId: string;
    caseStatus: CaseStatus | null;
    afterSeq: number;
    limit: number;
  }): Promise<ReconciliationItem[]>;
  /** Đọc và khóa (UPDLOCK) một dòng lệch. */
  lockItem(id: string): Promise<ReconciliationItem | null>;
  /** Chỉ đóng dòng còn `OPEN`. */
  resolveItem(
    id: string,
    resolution: { status: 'RESOLVED' | 'IGNORED'; resolvedBy: string; note: string; at: Date },
  ): Promise<void>;
  findTopupsByIds(ids: readonly string[]): Promise<WalletTopupView[]>;
  /** Lần nạp `SUCCEEDED` có `completed_at` trong `[from, to)`. */
  listSucceededTopups(from: Date, to: Date): Promise<WalletTopupView[]>;
  /** Giao dịch có tổng các dòng khác 0 (tối đa 1000). */
  findUnbalancedTransactions(): Promise<Array<{ transactionId: string; total: number }>>;
  /** Tài khoản có số dư cache khác tổng các dòng sổ cái của nó (tối đa 1000). */
  findBalanceMismatches(): Promise<
    Array<{ accountId: string; balance: number; ledgerTotal: number }>
  >;
}

export interface SettlementSource {
  /** Mọi charge hoàn tất trong ngày UTC `day` (mọi tenant). Ném `SettlementUnavailableError` hoặc `ReconciliationTooLargeError`. */
  fetchDay(day: string, maxCharges: number): Promise<GatewayCharge[]>;
}
