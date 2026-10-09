import type { ColumnType } from 'kysely';

export interface ChargesTable {
  id: string;
  reference: string;
  /** bigint: tedious trả về chuỗi khi đọc; ghi bằng number. */
  amount: ColumnType<string, number, number>;
  currency: string;
  status: string;
  failure_code: string | null;
  scenario: string;
  due_at: Date;
  created_at: Date;
  completed_at: Date | null;
}

export interface IdempotencyKeysTable {
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  charge_id: string;
  created_at: Date;
}

export interface WebhookEventsTable {
  event_id: string;
  charge_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  send_twice: boolean;
  created_at: Date;
  delivered_at: Date | null;
}

export interface WebhookAttemptsTable {
  event_id: string;
  attempt_no: number;
  attempted_at: Date;
  status_code: number | null;
  error_message: string | null;
}

export interface PaymentDatabase {
  charges: ChargesTable;
  idempotency_keys: IdempotencyKeysTable;
  webhook_events: WebhookEventsTable;
  webhook_attempts: WebhookAttemptsTable;
}
