import type { Charge } from '../domain/charge.js';
import type { WebhookEvent } from '../domain/webhook-event.js';
import type { PaymentState } from './state.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  chargeId(): string;
  eventId(): string;
}

export interface CompletedCursor {
  completedAt: Date;
  id: string;
}

export interface SettlementTotal {
  currency: string;
  status: 'SUCCEEDED' | 'FAILED';
  count: number;
  totalAmount: number;
}

export interface ChargeRepository {
  insert(charge: Charge): Promise<void>;
  findById(id: string): Promise<Charge | null>;
  /** Chọn charge PENDING đã đến hạn và khóa chúng (bỏ qua hàng đang bị khóa bởi worker khác). */
  lockDue(now: Date, limit: number): Promise<Charge[]>;
  save(charge: Charge): Promise<void>;
  listCompleted(query: {
    from: Date;
    to: Date;
    limit: number;
    after: CompletedCursor | null;
  }): Promise<Charge[]>;
  totals(range: { from: Date; to: Date }): Promise<SettlementTotal[]>;
}

export interface StoredResponse {
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  chargeId: string;
  createdAt: Date;
}

export interface IdempotencyStore {
  find(key: string): Promise<StoredResponse | null>;
  /** Ném `DuplicateKeyError` nếu khóa đã tồn tại. */
  save(record: StoredResponse): Promise<void>;
}

export interface WebhookAttemptRecord {
  eventId: string;
  attemptNo: number;
  attemptedAt: Date;
  statusCode: number | null;
  error: string | null;
}

export interface WebhookOutbox {
  add(event: WebhookEvent): Promise<void>;
  /** Chọn sự kiện PENDING đã đến hạn và khóa chúng (bỏ qua hàng đang bị khóa). */
  lockDue(now: Date, limit: number): Promise<WebhookEvent[]>;
  save(event: WebhookEvent): Promise<void>;
  recordAttempt(attempt: WebhookAttemptRecord): Promise<void>;
}

export interface WebhookSendResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export interface WebhookSender {
  send(event: WebhookEvent, now: Date): Promise<WebhookSendResult>;
}

export interface StateSnapshot {
  webhookPending: number;
  webhookOldestCreatedAt: Date | null;
}

/** Đọc số liệu trạng thái cho gauge; chỉ đọc. */
export interface StateRepository {
  snapshot(): Promise<StateSnapshot>;
}

export interface Logger {
  warn(details: object, message?: string): void;
}

/** Cổng đo đạc vận hành; adapter OpenTelemetry nằm ở infrastructure. */
export interface Metrics {
  /** Một charge vừa hoàn tất, theo trạng thái cuối (`SUCCEEDED` / `FAILED`). */
  charge(status: string): void;
  webhookDelivery(result: 'delivered' | 'retrying' | 'failed'): void;
  publishState(state: PaymentState): void;
}

export const noopMetrics: Metrics = {
  charge: () => {},
  webhookDelivery: () => {},
  publishState: () => {},
};

export interface Repositories {
  charges: ChargeRepository;
  idempotency: IdempotencyStore;
  webhooks: WebhookOutbox;
  state: StateRepository;
}

export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
