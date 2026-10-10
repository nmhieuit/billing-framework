import type { ColumnType, Generated } from 'kysely';

export interface AccountsTable {
  id: string;
  kind: string;
  customer_id: string | null;
  currency: string;
  /** bigint: đọc về là chuỗi, ghi bằng number. */
  balance: ColumnType<string, number, number>;
  created_at: Date;
}

export interface LedgerTransactionsTable {
  id: string;
  business_key: string;
  kind: string;
  created_at: Date;
}

export interface LedgerEntriesTable {
  /** identity bigint: đọc về là chuỗi, không ghi. */
  id: Generated<string>;
  transaction_id: string;
  account_id: string;
  amount: ColumnType<string, number, number>;
  created_at: Date;
}

export interface TopupsTable {
  id: string;
  customer_id: string;
  account_id: string;
  amount: ColumnType<string, number, number>;
  currency: string;
  status: string;
  charge_id: string | null;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface IdempotencyKeysTable {
  customer_id: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  topup_id: string;
  created_at: Date;
}

export interface ProcessedMessagesTable {
  consumer: string;
  message_id: string;
  processed_at: Date;
}

export interface OrderPaymentsTable {
  order_id: string;
  customer_id: string;
  wallet_transaction_id: string;
  amount: ColumnType<string, number, number>;
  currency: string;
  paid_at: Date;
}

export interface OutboxTable {
  id: string;
  event_type: string;
  routing_key: string;
  payload: string;
  correlation_id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
  sent_at: Date | null;
}

/** Tên bảng không có schema: repository luôn dựng trên `db.withSchema('t_<tenant>')`. */
export interface WalletDatabase {
  accounts: AccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  topups: TopupsTable;
  idempotency_keys: IdempotencyKeysTable;
  processed_messages: ProcessedMessagesTable;
  order_payments: OrderPaymentsTable;
  outbox: OutboxTable;
}
