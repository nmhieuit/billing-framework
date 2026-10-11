# Bước 6b — Dọn dữ liệu (retention): thiết kế

**Ngày:** 2026-10-12
**Trạng thái:** Chờ duyệt
**Phạm vi:** Job dọn dữ liệu định kỳ cho wallet và payment (outbox đã gửi, inbox khử trùng, khóa idempotency, lịch sử đối soát đã đóng, webhook đã giao), có chế độ chạy thử, metric và rule/dashboard Kibana. Là vòng hai của Bước 6 (vận hành). Dựa trên 6a (`2026-10-11-ops-metrics-alerts-design.md`), đối soát (`2026-10-10-reconciliation-design.md`) và ADR-0009 (outbox `SENT` chưa được dọn).

## 1. Mục tiêu và quyết định đã chốt

Các bảng dưới đây hiện chỉ tăng. Mục tiêu là giữ chúng bị chặn trên mà không bao giờ làm yếu khử trùng hay chạm vào dữ liệu tài chính.

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Thời hạn mặc định | Thận trọng (mục 2); mỗi loại chỉnh được bằng `RETENTION_*_DAYS`, có mức tối thiểu |
| 2 | Bật/tắt | `RETENTION_ENABLED=true` và `RETENTION_DRY_RUN=true` theo mặc định: chạy nhưng chỉ đếm và log; người vận hành tự đặt `RETENTION_DRY_RUN=false` để xóa thật |
| 3 | Cách xóa | Lô nhỏ `delete top (N) … with (readpast, rowlock)`, mỗi lô một transaction ngắn; không archive |
| 4 | Vị trí | `Worker` riêng trong từng service; use case `RunRetention` ở `application`, SQL ở `infrastructure` |
| 5 | Quan sát | Counter `billing.retention.rows{table, mode}`, gauge `billing.retention.last_success_timestamp_seconds`, rule Kibana `billing-retention-stalled`, một panel dashboard |

## 2. Chính sách

| Dữ liệu | Điều kiện xóa | Mặc định (biến) | Tối thiểu |
|---|---|---|---|
| Wallet `outbox` | `status = 'SENT'` và `sent_at < cutoff` | 14 ngày (`RETENTION_OUTBOX_SENT_DAYS`) | 1 |
| Wallet `processed_messages` | `processed_at < cutoff` | 30 ngày (`RETENTION_PROCESSED_MESSAGES_DAYS`) | 7 |
| Wallet `idempotency_keys` | `created_at < cutoff` | 90 ngày (`RETENTION_IDEMPOTENCY_KEYS_DAYS`) | 7 |
| Wallet `reconciliation_items` | `case_status in ('RESOLVED','IGNORED')` và `created_at < cutoff` | 365 ngày (`RETENTION_RECONCILIATION_DAYS`) | 30 |
| Wallet `reconciliation_runs` | `status <> 'RUNNING'`, `finished_at < cutoff`, không còn item nào | cùng `RETENTION_RECONCILIATION_DAYS` | 30 |
| Payment `webhook_attempts` rồi `webhook_events` | sự kiện `DELIVERED` và `delivered_at < cutoff` (xóa lịch sử thử trước rồi mới tới sự kiện) | 30 ngày (`RETENTION_WEBHOOK_DAYS`) | 1 |
| Payment `idempotency_keys` | `created_at < cutoff` | 90 ngày (`RETENTION_IDEMPOTENCY_KEYS_DAYS`) | 7 |

`cutoff = clock.now() - days`. Đồng hồ là `Clock` được tiêm, không dùng `Date.now()`.

### Luật an toàn

1. **Không bao giờ xóa** `ledger_transactions`, `ledger_entries`, `accounts`, `topups`, `order_payments` (wallet) và `charges` (payment). Danh sách chính sách là dữ liệu có kiểm tra bằng test: không chứa các bảng này; test tích hợp chứng minh số dòng của chúng không đổi sau một lượt dọn đầy đủ.
2. Dòng đối soát `OPEN` và lượt `RUNNING` không bao giờ bị xóa. Lượt còn dù chỉ một item thì được giữ. Webhook `PENDING` và `FAILED` (hết lượt thử) được giữ lại để điều tra.
3. Khử trùng vẫn đúng sau khi dọn: xóa `processed_messages` quá hạn chỉ làm một message giao lại rất muộn được xử lý lại; `order_payments` (phát lại `OrderPaidV1`) và trạng thái `topups` (`SUCCEEDED` chặn cộng trùng) vẫn chặn trừ/cộng trùng. Xóa `idempotency_keys` quá hạn nghĩa là cùng `Idempotency-Key` gửi lại sau cửa sổ đó được coi là yêu cầu mới (đó là ý nghĩa của "cửa sổ idempotency"; tài liệu nêu rõ).
4. Cấu hình có kiểm tra: mỗi số ngày nguyên, không nhỏ hơn mức tối thiểu ở bảng trên; sai thì service từ chối khởi động (cùng cách `loadConfig` hiện có).

## 3. Kiến trúc

- `packages/runtime`: `drainBatches(step, { batchSize, shouldContinue })` — gọi `step(batchSize)` lặp lại đến khi trả về ít hơn `batchSize`, `shouldContinue()` trả `false` (hết ngân sách thời gian) hoặc bị hủy; trả tổng số dòng.
- Wallet `application/retention.ts`: port `RetentionRepository { purge(policy: WalletRetentionPolicy, cutoff: Date, batchSize: number, dryRun: boolean): Promise<number> }` (một lần gọi = một lô, hoặc một phép đếm có chặn trần khi dry-run) và use case `RunRetention({ uow, registry, clock, metrics, log, config })`. `execute(signal)` lặp theo tenant và chính sách, dùng `drainBatches`; mỗi lô một `uow.run`; lỗi một tenant/chính sách được log ở mức `warn` rồi đi tiếp; dừng khi hết `RETENTION_MAX_SECONDS_PER_RUN` hoặc khi `signal` bị hủy. Trả `RetentionReport { rows: Record<string, number>; dryRun: boolean; errors: number }`.
- Payment `application/retention.ts`: cùng mẫu nhưng một schema (không có tenant).
- `Repositories.retention` ở cả hai service (SQL ở `infrastructure/kysely/retention.repository.ts`). Dry-run: `select count(*) from (select top (limit) 1 as x from … where …) t` với `limit = 1_000_000`.
- `Metrics.retentionRun(report)`: adapter OTel tăng `billing.retention.rows{table, mode}` (`mode` = `deleted` hoặc `would_delete`; wallet có thêm nhãn `tenant`) và đặt gauge `billing.retention.last_success_timestamp_seconds` về epoch hiện tại (giá trị đứng yên giữa các lần xuất, nên tuổi tăng dần cho tới lần thành công kế tiếp). Một lượt có lỗi thì không cập nhật gauge.
- Bootstrap: `Worker` riêng (`RETENTION_INTERVAL_MINUTES`, mặc định 60), dừng trong danh sách dừng trước `db.destroy()`. `RETENTION_ENABLED=false` thì không tạo worker.

## 4. Index và migration

- Wallet tenant migration `006-retention-indexes`: `ix_outbox_sent (sent_at) where status = 'SENT'` (index có lọc), `ix_processed_messages_at (processed_at)`, `ix_idempotency_keys_created (created_at)`.
- Payment migration `003-retention-indexes`: `ix_webhook_delivered (delivered_at) where status = 'DELIVERED'` (có lọc), `ix_payment_idempotency_created (created_at)`; `webhook_attempts` đã có khóa theo `event_id`.
- Tên migration kế tiếp các số hiện có (wallet `005`, payment `002`).

## 5. Cấu hình

Cả hai service: `RETENTION_ENABLED`, `RETENTION_DRY_RUN`, `RETENTION_INTERVAL_MINUTES` (1..1440, mặc định 60), `RETENTION_MAX_SECONDS_PER_RUN` (1..3600, mặc định 60), `RETENTION_BATCH_SIZE` (1..4000, mặc định 1000; trần 4000 để dưới ngưỡng nâng cấp khóa của SQL Server). Riêng từng service: các biến `*_DAYS` ở mục 2. Boolean chỉ nhận `true`/`false`. Vào `.env.example` và `env-example.test.ts`; compose local đặt `RETENTION_DRY_RUN=true` rõ ràng.

## 6. Kibana

- Rule `billing-retention-stalled` (rule thứ 9, tham số `maxAgeHours` mặc định 3; `intervalMinutes` 15, `windowMinutes` 30, `severity` `high`): ES|QL lấy `LAST(billing.retention.last_success_timestamp_seconds, @timestamp)` theo `service` trong cửa sổ tra cứu (tham số `lookbackHours`, mặc định 24) và báo khi tuổi lớn hơn `maxAgeHours * 3600`; định danh alert là cột `service`. Job tắt (không gauge) thì rule không nổ, và rule cũng tự hết sau `lookbackHours` im lặng — ghi trong tài liệu.
- Dashboard thêm một panel (đường: số dòng theo bảng và `mode`, lũy kế; kèm tuổi lượt thành công cuối). Mô tả bằng tiếng Việt.
- Tham số, schema, bộ sinh `.ndjson` và test "file commit khớp bộ sinh" dùng lại cơ chế 6a; bảng tham số trong `docs/ops/kibana-alerts-and-dashboard.vi.md` có thêm khóa mới (đã có test chống lệch).

## 7. Kiểm thử

- **Unit:** cấu hình (mặc định, ghi đè, mỗi mức tối thiểu chấp nhận ở biên và từ chối dưới biên, boolean sai); `drainBatches` (dừng khi lô nhỏ, khi hết ngân sách, khi hủy); `RunRetention` với repository giả (dry-run không gọi đường xóa, cô lập lỗi theo tenant và theo chính sách, tổng hợp báo cáo, metric được gọi một lần); adapter OTel (counter, gauge, lượt lỗi không cập nhật gauge); danh sách chính sách không chứa bảng cấm.
- **Integration (SQL Server):** mỗi chính sách xóa dòng đủ điều kiện và giữ dòng không đủ (outbox `PENDING` cũ và `SENT` mới, item `OPEN`, run còn item, run `RUNNING`, webhook `PENDING`/`FAILED`, event `DELIVERED` mới); thứ tự khóa ngoại payment; đúng cỡ lô; hai lượt chạy song song không lỗi; **số dòng `ledger_*`, `accounts`, `topups`, `order_payments`, `charges` không đổi sau một lượt dọn đầy đủ**; index tồn tại (test migration).
- **Service:** worker retention chạy trong service dựng đầy đủ: dry-run chỉ ghi `would_delete` và không xóa gì; chế độ thật xóa dữ liệu đã gieo (đồng hồ giả tua xa); dừng service dừng worker.
- **Kibana:** như 6a (bộ sinh, tham số, file commit khớp), cộng kiểm chứng trên stack Docker thật: áp dụng, rule chạy không lỗi, panel truy vấn không lỗi.

## 8. Tài liệu

`docs/ops/retention.vi.md` (bảng chính sách và lý do, luật an toàn, cách chuyển từ chạy thử sang xóa thật, đọc counter và gauge, ý nghĩa cửa sổ idempotency, không có đường hoàn tác), ADR-0012, cập nhật README, ADR-0009 (mục outbox `SENT`), runbook liên quan, `.env.example` hai service, bảng tham số Kibana.

## 9. Rủi ro đã biết

- Xóa là không hoàn tác; chế độ chạy thử mặc định và tài liệu quy trình chuyển đổi là lớp bảo vệ chính.
- Hai pod cùng chạy retention làm việc trùng nhưng không sai (`readpast`); chấp nhận được.
- `RETENTION_MAX_SECONDS_PER_RUN` có thể không đủ để xóa hết một khối dữ liệu tồn đọng lớn ngay lần đầu; các lượt kế tiếp tiếp tục (mỗi giờ), nên lần đầu có thể mất nhiều lượt.
- Gauge dựa trên mốc thời gian: nếu đồng hồ lệch giữa service và Elasticsearch thì tuổi sai lệch tương ứng.

## 10. Ngoài phạm vi

Archive trước khi xóa; xóa dữ liệu tài chính; API dọn tay; dọn index Elasticsearch (do chính sách vòng đời index của hạ tầng); công cụ vận hành (6c), chaos (6d), tối ưu `MERCHANT` (6e).
