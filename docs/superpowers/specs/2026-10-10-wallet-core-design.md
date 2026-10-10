# Wallet Core — Thiết kế

**Ngày:** 2026-10-10
**Trạng thái:** Chờ duyệt
**Phạm vi:** Bước 3 của lộ trình trong [`2026-10-09-billing-framework-design.md`](2026-10-09-billing-framework-design.md) — service `wallet` (NestJS): ví theo khách hàng và theo tenant, ledger ghi sổ kép bất biến, nạp tiền qua `payment` (HTTP + webhook), chống trùng, inbox. Dùng hợp đồng của [`2026-10-09-payment-simulator-design.md`](2026-10-09-payment-simulator-design.md).

## 1. Mục tiêu và phạm vi

Wallet giữ số dư của khách (ví nạp trước) và chứng minh được số dư đó bằng sổ cái. Bước này cho phép: tạo ví, nạp tiền vào ví qua payment, xem số dư và bút toán. Mọi thứ phải đúng khi có nhiều tenant, lặp request, lặp webhook, restart và lỗi giữa chừng.

**Ngoài phạm vi:** thanh toán order qua event (Bước 4, cần team ecommerce), `outbox`/`messaging` RabbitMQ (Bước 4, nơi event đầu tiên `order-paid` ra đời), đối soát (Bước 5), hoàn tiền, rút tiền, ví nhiều đồng tiền, xác thực người dùng (việc của gateway), trừu tượng hóa idempotency dùng chung giữa hai service.

### Các quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Mô hình tài khoản | Mỗi khách một ví, cố định một đồng tiền (`VND` hoặc `USD`) ngay khi tạo |
| 2 | Đa tenant | Mỗi tenant một schema `t_<tenant>` trong database `billing_wallet`; tenant lấy từ header của gateway (API) hoặc từ payload đã ký (webhook), không bao giờ từ body/query |
| 3 | Định tuyến webhook về tenant | Mở rộng payment: `POST /charges` nhận `metadata`, payment trả lại trong webhook |
| 4 | Gọi payment khi nạp tiền | Lai: thử ngay sau khi trả `202`, thất bại thì worker; dùng chung một use case |
| 5 | `outbox`/`messaging` | Hoãn sang Bước 4 |
| 6 | Tạo ví | Tường minh qua `POST /wallets`; nạp vào ví chưa có → `404` |

## 2. Định danh và quy tắc tenant

- Mọi API (trừ webhook và `GET /health`) bắt buộc header `X-Tenant-Id` và `X-Customer-Id`, do gateway/BFF đặt. Không đọc tenant hay khách từ body hoặc query.
- `tenantId` hợp lệ khi khớp `^[a-z][a-z0-9-]{0,39}$` **và** nằm trong danh sách cấu hình `WALLET_TENANTS`. `customerId` khớp `^[A-Za-z0-9_-]{1,64}$`.
- Thiếu tenant → `400 MISSING_TENANT`; tenant không có trong danh sách (hoặc sai dạng) → `403 UNKNOWN_TENANT`; thiếu khách → `400 MISSING_CUSTOMER`; khách sai dạng → `400 INVALID_REQUEST`.
- Webhook không dùng header tenant: tenant lấy từ `data.metadata.tenantId` **sau khi** chữ ký HMAC hợp lệ, và phải thuộc danh sách tenant.
- `TenantId` là value object ở domain, chỉ tạo được qua `TenantId.parse`; `TenantRegistry` biến chuỗi thô thành `TenantId` hợp lệ. Mọi truy cập DB đi qua `TenantUnitOfWork.run(tenant, work)` và không có cách lấy repository mà không đưa `TenantId`. Use case nhận tham số tường minh `{ tenant, customerId }`, không dùng ngữ cảnh ngầm. Tên schema luôn dựng từ `TenantId` đã kiểm tra và luôn được quote; câu SQL thô luôn dùng tên bảng có schema.

## 3. API của wallet

Định dạng lỗi dùng chung: `{ "error": { "code", "message" } }`; mọi response có `x-correlation-id`; `500 INTERNAL` không lộ thông điệp gốc.

| Endpoint | Hành vi |
|---|---|
| `POST /wallets` | Body `{ currency }` (`VND`\|`USD`). Chưa có ví → `201`; đã có cùng đồng tiền → `200` trả ví đó; khác đồng tiền → `409 WALLET_CURRENCY_CONFLICT`; khách sai dạng → `400 INVALID_REQUEST`; `currency` không hỗ trợ → `400 INVALID_REQUEST` |
| `GET /wallet` | Ví của khách gọi: `{ customerId, currency, balance, createdAt }`; chưa có → `404 WALLET_NOT_FOUND` |
| `POST /topups` | Header `Idempotency-Key` bắt buộc (1..255 ký tự, không có khoảng trắng đầu/cuối, thiếu → `400 MISSING_IDEMPOTENCY_KEY`, sai dạng → `400 INVALID_IDEMPOTENCY_KEY`). Body `{ amount }`: số nguyên minor unit `>= 1`; đồng tiền lấy từ ví. Chưa có ví → `404 WALLET_NOT_FOUND`. Luôn trả `202 { topupId, status: "REQUESTED", amount, currency, createdAt }`. Cùng key + cùng nội dung → trả lại đúng phản hồi đã lưu; cùng key + nội dung khác → `422 IDEMPOTENCY_KEY_REUSED` |
| `GET /topups/{id}` | Lần nạp của chính khách: `{ topupId, status, amount, currency, failureCode?, createdAt, completedAt? }`; của khách/tenant khác → `404 TOPUP_NOT_FOUND` |
| `GET /wallet/entries` | Bút toán ledger của ví, tăng dần theo `entryId`, phân trang `limit` (mặc định 100, tối đa 1000) và `cursor`; mỗi dòng `{ entryId, transactionId, businessKey, amount, createdAt }`. `limit`/`cursor` sai → `400 INVALID_QUERY` |
| `POST /webhooks/payment` | Mục 6. Chữ ký sai/thiếu/hết hạn → `401 INVALID_SIGNATURE`; payload sai hoặc tenant lạ → `400 INVALID_WEBHOOK`; đã xử lý, trùng hoặc bỏ qua có chủ đích → `200` |
| `GET /health` | Đã có |

## 4. Mô hình dữ liệu và ledger

Database `billing_wallet`; mỗi tenant một schema `t_<tenant>`. Không có bảng toàn cục. Bảng theo dõi migration của Kysely nằm trong từng schema.

### Quy ước sổ kép

Mỗi dòng bút toán có `amount` có dấu (số nguyên minor unit, khác 0). Tổng các dòng của một giao dịch bằng `0`. Số dư tài khoản bằng tổng `amount` của các dòng của nó. Nạp `X` là: ví `+X`, `GATEWAY` `−X`. Hệ quả: **tổng số dư mọi tài khoản của một tenant luôn bằng 0** (bất biến cho Bước 5). Ví không bao giờ âm; tài khoản `GATEWAY` không bao giờ dương.

### Bảng trong mỗi schema tenant

- **`accounts`**: `id` (khóa chính, dựng tất định: `wallet:<customerId>`, `system:GATEWAY:<VND|USD>`, `system:MERCHANT:<VND|USD>`), `kind` (`WALLET`|`GATEWAY`|`MERCHANT`), `customer_id` (null với tài khoản hệ thống), `currency`, `balance` (bigint, cache), `created_at`. `CHECK`: ví `balance >= 0`, `GATEWAY` `balance <= 0`. Bốn tài khoản hệ thống được tạo bởi migration. Một ví/khách được bảo đảm bởi chính khóa chính.
- **`ledger_transactions`**: `id`, `business_key` (**unique**, ví dụ `topup:<topupId>`), `kind` (`TOPUP`), `created_at`.
- **`ledger_entries`**: `id` (identity), `transaction_id`, `account_id`, `amount` (có dấu, khác 0), `created_at`; index `(account_id, id)`.
- **`topups`**: `id` (`tp_<32 hex>`), `customer_id`, `account_id`, `amount` (`> 0`), `currency`, `status` (`REQUESTED`|`PENDING`|`SUCCEEDED`|`FAILED`), `charge_id`, `failure_code`, `attempts`, `next_attempt_at`, `created_at`, `completed_at`; index `(status, next_attempt_at, id)` cho worker và `(customer_id, created_at)`.
- **`idempotency_keys`**: khóa chính `(customer_id, idempotency_key)` với collation `Latin1_General_100_BIN2`, `request_hash`, `response_status`, `response_body`, `topup_id`, `created_at`.
- **`processed_messages`**: khóa chính `(consumer, message_id)` (inbox khử trùng webhook theo `eventId`), `processed_at`.

### Bất biến được ép ở nhiều lớp

- **Domain:** `LedgerTransaction` phải có ít nhất 2 dòng, cùng đồng tiền, mỗi dòng khác 0, tổng bằng 0; `Account.apply` từ chối làm số dư vi phạm quy tắc của loại tài khoản.
- **DB:** `CHECK` số dư theo loại, `business_key` unique, và trigger `INSTEAD OF UPDATE` / `INSTEAD OF DELETE` trên `ledger_entries` và `ledger_transactions` (ném lỗi) để sổ cái chỉ ghi thêm bất kể quyền; sửa sai bằng bút toán đảo.
- **Đồng thời:** khi ghi giao dịch, khóa các tài khoản liên quan bằng `UPDLOCK` theo thứ tự `id` rồi cập nhật số dư và chèn dòng trong cùng transaction.

## 5. Luồng nạp tiền

### Trạng thái lần nạp

`REQUESTED → PENDING → SUCCEEDED | FAILED`. Webhook có thể đưa `REQUESTED` hoặc `PENDING` thẳng tới trạng thái cuối. Một lần nạp `FAILED` do hết lượt gọi payment (`PAYMENT_UNAVAILABLE`) vẫn được chuyển thành `SUCCEEDED` nếu webhook `charge.succeeded` về sau (cổng thanh toán là nguồn sự thật về tiền); `SUCCEEDED` không bao giờ chuyển sang trạng thái khác (`charge.failed` đến sau `SUCCEEDED` bị bỏ qua và ghi log lỗi).

### Gọi payment (một use case dùng chung)

1. `POST /topups`: trong một transaction kiểm tra ví, xử lý idempotency, ghi lần nạp `REQUESTED` với `next_attempt_at = now`. Trả `202` rồi **kích hoạt một lần thử gửi sang payment** không chờ; lỗi của lần thử này chỉ ghi log.
2. Worker định kỳ (`WORKER_INTERVAL_MS`), lần lượt qua từng tenant cấu hình, gọi cùng use case cho các lần nạp `REQUESTED` đến hạn; nó nhận tín hiệu dừng và kiểm tra giữa các lần nạp.
3. `SubmitTopup`: (a) trong transaction ngắn chiếm một lần nạp bằng lease 60 giây (`UPDLOCK, READPAST`, đẩy `next_attempt_at`); (b) gọi `POST /charges` **ngoài transaction** với `Idempotency-Key = topup:<tenant>:<topupId>`, `reference = <topupId>`, `metadata = { tenantId }`, timeout `PAYMENT_TIMEOUT_MS`; (c) ghi kết quả trong transaction mới.
4. Kết quả: `202` → `PENDING` và lưu `charge_id`. `4xx` → `FAILED` ngay với `PAYMENT_REJECTED` (lỗi đầu vào, không thử lại). Lỗi mạng, timeout, `5xx` → thử lại theo `TOPUP_SUBMIT_BACKOFF` (mặc định `1,5,30,120,600` giây): lần thất bại thứ `n` (`n <= len`) hẹn lại sau `backoff[n-1]` giây; lần thứ `len+1` → `FAILED` với `PAYMENT_UNAVAILABLE`. Gọi lại luôn an toàn nhờ idempotency key của payment.

### Mở rộng payment: `metadata`

`POST /charges` nhận thêm `metadata` tùy chọn: đối tượng chuỗi→chuỗi, tối đa 10 khóa, khóa khớp `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, giá trị tối đa 200 ký tự; sai → `400 INVALID_REQUEST`. Payment lưu (cột `metadata nvarchar(max) null`, migration `002` mới của payment), đưa vào hash idempotency (đã chuẩn hóa thứ tự khóa), và trả lại trong `GET /charges/{id}`, trong `data.metadata` của webhook và trong các dòng `settlements`. Contract trong `@billing/contracts` chỉ **thêm** trường tùy chọn `data.metadata` (tương thích ngược).

## 6. Webhook từ payment

`POST /webhooks/payment` (`ApplyPaymentResult`), thân thô phải được giữ nguyên để kiểm chữ ký.

1. Xác thực `X-Signature` bằng `verifyWebhook` với `PAYMENT_WEBHOOK_SECRET` (dung sai mặc định 300 giây); sai → `401`.
2. Kiểm tra payload bằng `validateChargeWebhook` và lấy `data.metadata.tenantId`; thiếu, sai dạng hoặc ngoài danh sách tenant → `400`.
3. Trong **một transaction** của schema tenant:
   - chèn `processed_messages (consumer = "payment-webhook", message_id = eventId)`; trùng khóa → rollback và trả `200`, không có tác động;
   - khóa dòng lần nạp (`UPDLOCK`) tìm theo `id = data.reference`; không có → ghi log lỗi và trả `200` (tránh payment retry vô ích; Bước 5 sẽ phát hiện);
   - số tiền hoặc đồng tiền khác lần nạp → không đụng sổ, ghi log lỗi, trả `200`;
   - `charge.succeeded` → ghi giao dịch `topup:<id>` (ví `+X`, `GATEWAY −X`), đặt `SUCCEEDED`, `completed_at`, `charge_id`; đã `SUCCEEDED` thì không làm gì;
   - `charge.failed` → đặt `FAILED` kèm `failureCode` (chỉ khi chưa `SUCCEEDED`).
4. Bí mật webhook và chữ ký không bao giờ xuất hiện trong log hay thông báo lỗi.

### Chống trùng khi ghi tiền (nhiều lớp)

| Lớp | Chặn |
|---|---|
| Idempotency key API `(customer_id, key)` + hash nội dung | Gọi lặp `POST /topups` |
| `Idempotency-Key` gửi payment | Gọi lặp `POST /charges` khi retry hoặc khi lần thử ngay và worker chạm nhau |
| Inbox `processed_messages (eventId)` | Webhook gửi lại; hai webhook trùng đồng thời (bên sau vấp khóa chính, rollback, trả `200`) |
| Trạng thái lần nạp + khóa dòng `topups` | Webhook và worker cùng chạm một lần nạp |
| `business_key = topup:<id>` unique trong ledger | Ghi sổ trùng dù mọi lớp trên bị bỏ qua |
| `UPDLOCK` tài khoản theo thứ tự `id` | Hai giao dịch cùng ví: số dư đúng, không deadlock |
| Trigger bất biến + `CHECK` số dư | Sửa/xóa sổ cái, ví âm |

## 7. Kiến trúc và cấu trúc code

Bốn lớp theo quy ước repo; NestJS luôn tiêm phụ thuộc bằng `@Inject(TOKEN)` tường minh.

- **`domain`** (chỉ dùng `@billing/money`): `TenantId`, `Account`, `LedgerTransaction`, `Topup`.
- **`application`**: `CreateWallet`, `GetWallet`, `ListEntries`, `RequestTopup`, `GetTopup`, `SubmitTopup`, `SubmitDueTopups`, `ApplyPaymentResult`, các port (`TenantUnitOfWork`, `PaymentGateway`, `TenantRegistry`, `Clock`, `IdGenerator`).
- **`infrastructure`**: repository Kysely theo schema tenant, `HttpPaymentGateway`, `ConfigTenantRegistry`.
- **`interface`**: controller, guard tenant/khách, ánh xạ lỗi, webhook controller giữ body thô.
- Composition root: `app.module.ts`, `bootstrap.ts`, `main.ts`.

**Package dùng chung mới `@billing/runtime`:** `Worker` (có `AbortSignal`), `runAll`, `once`, `createShutdownHandler`, `startOrExit` được tách khỏi payment (payment chuyển sang dùng, test dời theo) vì wallet cũng cần.

**Cấp phát tenant:** `corepack pnpm db:migrate:wallet` duyệt qua `WALLET_TENANTS`: tạo schema nếu chưa có, chạy migration trong schema (bảng migration nằm trong schema), tạo tài khoản hệ thống; idempotent. Khi khởi động wallet kiểm tra mọi tenant đã migrate xong, nếu chưa thì từ chối chạy kèm thông báo rõ.

## 8. Cấu hình wallet

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng HTTP | `3001` |
| `WALLET_DB_HOST`, `WALLET_DB_PORT`, `WALLET_DB_NAME`, `WALLET_DB_USER`, `WALLET_DB_PASSWORD` | Kết nối SQL Server | không có (bắt buộc); `WALLET_DB_PORT` mặc định `1433` |
| `WALLET_TENANTS` | Danh sách tenant, ngăn cách bằng dấu phẩy, mỗi tenant khớp regex ở mục 2 | không có (bắt buộc, ít nhất một) |
| `PAYMENT_BASE_URL` | Địa chỉ gốc của payment (http/https tuyệt đối) | không có (bắt buộc) |
| `PAYMENT_WEBHOOK_SECRET` | Khóa kiểm chữ ký webhook | không có (bắt buộc) |
| `PAYMENT_TIMEOUT_MS` | Timeout mỗi lần gọi payment | `5000` |
| `TOPUP_SUBMIT_BACKOFF` | Các mốc retry gọi payment (giây) | `1,5,30,120,600` |
| `WORKER_INTERVAL_MS` | Chu kỳ poll của worker | `500` |
| `WALLET_MIGRATOR_DB_USER`, `WALLET_MIGRATOR_DB_PASSWORD` | Tài khoản `db_owner` chỉ dùng cho `db:migrate:wallet` (đặt cả hai hoặc không đặt); service không đọc | không có (tùy chọn) |

Thiếu hoặc sai thì service từ chối khởi động và liệt kê mọi vấn đề cùng lúc. Không có giá trị mặc định cho bí mật.

## 9. Kiểm thử

| Tầng | Nội dung |
|---|---|
| Unit | `TenantId` và registry, `Account.apply` theo loại tài khoản, `LedgerTransaction`, máy trạng thái `Topup`, config, các phép toán của `@billing/runtime` |
| Integration (SQL Server thật) | Migration theo tenant (idempotent, hai tenant, trigger bất biến, `CHECK`, tài khoản hệ thống); **cô lập tenant** (cùng `customerId` ở hai tenant độc lập hoàn toàn); repository; `RequestTopup` (idempotency, 5 request đồng thời cùng key); `SubmitTopup`/`SubmitDueTopups` (retry, lease, dừng giữa chừng, `4xx`/`5xx`/timeout); `ApplyPaymentResult` (credit đúng một lần, webhook trùng đồng thời, thành công muộn sau `FAILED`, lệch số tiền, lần nạp lạ, thất bại); bất biến "tổng số dư tenant bằng 0" sau mỗi kịch bản |
| API | Nest + Fastify `inject`: header tenant/khách, mã lỗi, chữ ký webhook trên body thô (sai, lệch giờ), ánh xạ lỗi |
| Service e2e | Wallet thật + payment giả (HTTP server kịch bản trong `@billing/testing`): payment chết rồi sống lại, trả `4xx`, timeout |
| Cross-service e2e | Thư mục `tests/` ở gốc repo (không bị lint cấm import chéo service): payment thật + wallet thật, nạp tiền từ đầu đến cuối, số dư khớp ledger và sao kê payment |

## 10. Kế hoạch task dự kiến

1. `@billing/runtime`. 2. Payment `metadata`. 3. Wallet config, `TenantId`, `TenantRegistry`. 4. Domain `Account`/`LedgerTransaction`/`Topup`. 5. Migration theo tenant + `db:migrate:wallet` + kiểm tra khởi động. 6. Port, repository, `TenantUnitOfWork`, harness hai tenant. 7. `CreateWallet`/`GetWallet`/`ListEntries`. 8. `RequestTopup`. 9. `PaymentGateway`, `SubmitTopup`, `SubmitDueTopups`. 10. `ApplyPaymentResult`. 11. Lớp Nest (controller, guard, lỗi, webhook body thô). 12. Bootstrap/main/worker/tắt êm + payment giả + service e2e. 13. Cross-service e2e. 14. Tài liệu, ADR, `.env.example`, đồng bộ spec. 15. Kiểm chứng và hoàn tất nhánh.

## 11. Rủi ro cần kiểm chứng sớm và câu hỏi mở

- **Đã kiểm chứng:** lấy body thô của NestJS + Fastify (`rawBody: true`, byte gốc được giữ nguyên); `withSchema` và `sql.id(schema, tên)` với SQL thô; `Migrator` với `migrationTableSchema`; `CREATE SCHEMA` bằng quyền `db_ddladmin`.
- **Phát hiện khi kiểm chứng:** `Migrator` của Kysely cần `db_owner` (`sp_getapplock`), nên có login migrator riêng cho cả hai DB (xem ADR-0006 và `deploy/sql/init.sql`); `db:migrate:payment` của Bước 2 cũng được sửa theo.
- **Còn mở:** instance SQL Server dùng chung cho DB billing (ADR-0004, không chặn bước này); đồng bộ danh sách tenant giữa gateway của ecommerce và `WALLET_TENANTS` trước khi chạy thật.
