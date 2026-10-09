import { sql, type Kysely } from 'kysely';

// Index (status, due_at, id) và (status, next_attempt_at, event_id) là BẮT BUỘC: không có chúng,
// `top (n) ... order by ... with (updlock, readpast)` quét và khóa mọi hàng nên worker thứ hai nhận về rỗng.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table charges (
      id nvarchar(64) not null primary key,
      reference nvarchar(200) not null,
      amount bigint not null,
      currency nvarchar(3) not null,
      status nvarchar(16) not null,
      failure_code nvarchar(64) null,
      scenario nvarchar(max) not null,
      due_at datetime2(3) not null,
      created_at datetime2(3) not null,
      completed_at datetime2(3) null,
      constraint ck_charges_amount check (amount > 0),
      constraint ck_charges_status check (status in ('PENDING', 'SUCCEEDED', 'FAILED')),
      constraint ck_charges_currency check (currency in ('VND', 'USD'))
    )`.execute(db);
  await sql`create index ix_charges_due on charges (status, due_at, id)`.execute(db);
  await sql`create index ix_charges_completed on charges (completed_at, id)`.execute(db);

  await sql`
    create table idempotency_keys (
      idempotency_key nvarchar(255) not null primary key,
      request_hash nvarchar(64) not null,
      response_status int not null,
      response_body nvarchar(max) not null,
      charge_id nvarchar(64) not null references charges (id),
      created_at datetime2(3) not null
    )`.execute(db);

  await sql`
    create table webhook_events (
      event_id nvarchar(64) not null primary key,
      charge_id nvarchar(64) not null references charges (id),
      event_type nvarchar(32) not null,
      payload nvarchar(max) not null,
      status nvarchar(16) not null,
      attempts int not null,
      next_attempt_at datetime2(3) null,
      send_twice bit not null,
      created_at datetime2(3) not null,
      delivered_at datetime2(3) null,
      constraint ck_webhook_events_status check (status in ('PENDING', 'DELIVERED', 'FAILED'))
    )`.execute(db);
  await sql`create index ix_webhook_due on webhook_events (status, next_attempt_at, event_id)`.execute(
    db,
  );

  await sql`
    create table webhook_attempts (
      event_id nvarchar(64) not null references webhook_events (event_id),
      attempt_no int not null,
      attempted_at datetime2(3) not null,
      status_code int null,
      error_message nvarchar(500) null,
      primary key (event_id, attempt_no)
    )`.execute(db);
}
