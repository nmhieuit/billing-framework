# Payment Simulator — Thiết kế

**Ngày:** 2026-10-09
**Trạng thái:** Chờ duyệt
**Phạm vi:** Bước 2 của lộ trình trong [`2026-10-09-billing-framework-design.md`](2026-10-09-billing-framework-design.md) — service `payment` (Fastify): charge, webhook ký HMAC, kịch bản lỗi điều khiển được, idempotency key, sao kê.

## 1. Mục tiêu

`payment` là cổng thanh toán **giả lập** đủ đáng tin để chứng minh được số tiền ở wallet khớp với gateway. Nó phải:

- Nhận yêu cầu thu tiền (charge) và thông báo kết quả cho wallet bằng webhook, giống cách cổng thật làm.
- Tái tạo được các tình huống lỗi mà wallet và đối soát cần chịu được: thất bại, chậm, mất webhook, webhook trùng, mất phản hồi.
- Giữ trạng thái bền vững qua restart, để sao kê và webhook chưa gửi không bị mất.

### Các quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Điều khiển kịch bản | Header `X-Simulate` theo từng request; mặc định thành công |
| 2 | Đích webhook | Một endpoint cấu hình sẵn (`WEBHOOK_URL`, `WEBHOOK_SECRET`); request không mang URL |
| 3 | Lưu trữ | SQL Server, DB riêng `billing_payment`, truy cập bằng Kysely |
| 4 | Retry webhook | Có giới hạn với backoff; hết lượt thì đánh dấu `FAILED` và giữ lại |
| 5 | Sao kê | Theo `completedAt` (UTC), gồm cả `SUCCEEDED` và `FAILED` |

## 2. API

| Endpoint | Mục đích |
|---|---|
| `POST /charges` | Tạo charge. Header `Idempotency-Key` (bắt buộc), `X-Simulate` (tùy chọn). Body `{ amount, currency, reference }`. Trả `202` với `{ chargeId, status: "PENDING", ... }` |
| `GET /charges/{id}` | Trạng thái hiện tại của một charge; `404` nếu không có |
| `GET /settlements?date=YYYY-MM-DD` | Sao kê (mục 6) |
| `GET /health` | Đã có ở skeleton |

- `amount`: số nguyên minor unit `>= 1`. `currency`: `VND | USD`. Cùng quy tắc với `@billing/money`.
- `reference`: chuỗi không rỗng do bên gọi đặt (ví dụ id yêu cầu nạp tiền của wallet); payment lưu và trả lại nguyên vẹn.
- Thiếu `Idempotency-Key`, `amount` không phải số nguyên dương, `currency` lạ, hoặc `X-Simulate` không hợp lệ đều trả `400` với mã lỗi rõ ràng.
- Mọi response có header `x-correlation-id`.

### Vòng đời charge

`PENDING → SUCCEEDED | FAILED`. Hai trạng thái sau là cuối: không chuyển ngược, không chuyển hai lần. Khi hoàn tất ghi `completedAt`; nếu thất bại ghi thêm `failureCode`. Kết quả được thông báo bằng webhook, không phải bằng phản hồi của `POST`.

### Idempotency

- Cùng `Idempotency-Key` và cùng nội dung → trả lại đúng phản hồi `202` đã lưu (cùng `chargeId`), không tạo charge mới.
- Cùng key, nội dung khác → `422`.
- Hai request đồng thời cùng key: request đến sau vấp khóa chính của `idempotency_keys` và đọc lại kết quả đã lưu, không tạo trùng.
- Key được lưu vĩnh viễn (bộ giả lập, không hết hạn).
- Nội dung được so bằng hash của `{ amount, currency, reference, X-Simulate }`.

## 3. Kịch bản `X-Simulate`

Giá trị là danh sách `khóa=giá trị` ngăn cách bằng dấu phẩy, ví dụ `delay=5,fail=card_declined`. Không có header thì charge thành công. Giá trị không hợp lệ hoặc khóa lạ trả `400` (không đoán).

| Token | Hiệu ứng |
|---|---|
| `fail=<code>` | Charge kết thúc `FAILED` với `failureCode=<code>`. `<code>` khớp `^[a-z][a-z0-9_]{0,63}$` |
| `delay=<giây>` | Kết quả cuối chỉ có sau N giây (số nguyên `1..3600`); trong lúc chờ charge ở `PENDING` |
| `webhook=drop` | Charge hoàn tất nhưng không tạo webhook nào, để tái tạo tình huống "mất webhook" |
| `webhook=duplicate` | Mỗi webhook được gửi hai lần liên tiếp với cùng `eventId` |
| `response=timeout` | Charge được tạo và xử lý bình thường, nhưng phản hồi của `POST` bị giữ `RESPONSE_TIMEOUT_MS` trước khi trả. Client thấy timeout dù charge đã tồn tại |

`response=timeout` chỉ áp dụng cho **lần tạo charge đầu tiên**. Request lặp lại cùng `Idempotency-Key` (kể cả khi vẫn gửi `X-Simulate: response=timeout`, vì header nằm trong hash nội dung) được trả ngay phản hồi đã lưu, để client có lối thoát bằng cách gọi lại.

`webhook=drop` và `webhook=duplicate` loại trừ nhau (`400` nếu cùng có). Các token khác kết hợp tự do; `fail` cùng `delay` nghĩa là thất bại sau N giây.

## 4. Webhook

- **Sự kiện:** `charge.succeeded`, `charge.failed`, gửi bằng `POST` tới `WEBHOOK_URL`.
- **Payload:** `{ eventId, type, createdAt, data: { chargeId, reference, amount, currency, status, completedAt, failureCode? } }`. `eventId` ổn định cho mỗi sự kiện, kể cả khi gửi lại.
- **Chữ ký:** header `X-Signature: t=<unix>,v1=<hex>` với `v1 = HMAC-SHA256(WEBHOOK_SECRET, "<t>.<body thô>")`. Người nhận kiểm tra chữ ký bằng so sánh thời gian hằng và từ chối nếu `t` lệch quá dung sai (tham số `verifyWebhook` của bên nhận, mặc định 300 giây, xem `@billing/contracts`) (chống replay).
- **Giao hàng:** `2xx` là thành công; mọi trường hợp khác (kể cả lỗi mạng và timeout phía gửi) là thất bại và được retry theo backoff `WEBHOOK_BACKOFF` (mặc định `1,5,30,120,600` giây): gửi lần đầu ngay khi charge hoàn tất, sau đó tối đa 5 lần retry (tổng tối đa 6 lần gửi). Hết lượt thì sự kiện chuyển `FAILED` và được giữ lại. Charge vẫn ở trạng thái cuối đã hoàn tất.
- **Bền vững:** sự kiện được ghi trong cùng transaction với việc hoàn tất charge; worker lấy ra gửi. Restart không làm mất sự kiện chưa gửi.
- **Schema:** payload webhook được định nghĩa trong `@billing/contracts` (HTTP, tách khỏi envelope RabbitMQ) để wallet validate bằng cùng nguồn sự thật. Đây là hợp đồng mới cần thêm vào package.

## 5. Kiến trúc nội bộ

Bốn lớp theo quy ước repo (`docs/architecture/README.md`), lint ép ranh giới.

- **`domain`** (chỉ dùng `@billing/money`): `Charge` (máy trạng thái), `Scenario` (phân tích `X-Simulate`), `WebhookEvent`.
- **`application`**: use case `CreateCharge`, `CompleteDueCharges`, `DeliverDueWebhooks`, `GetCharge`, `GetSettlement`. Port: `ChargeRepository`, `IdempotencyStore`, `WebhookOutbox`, `WebhookSender`, `UnitOfWork`, `Clock`, `IdGenerator`.
- **`infrastructure`**: adapter Kysely cho các repository, `HttpWebhookSender` (ký HMAC, gửi bằng `fetch`), worker định kỳ.
- **`interface`**: route Fastify, kiểm tra đầu vào, ánh xạ lỗi sang HTTP. `src/main.ts` là composition root.

### Cách xử lý

`POST /charges` không hoàn tất charge trong request. Nó ghi charge `PENDING` với `due_at` (= thời điểm tạo, hoặc cộng `delay`) và trả `202`. Một worker (mặc định poll mỗi `WORKER_INTERVAL_MS = 500`) chạy hai việc:

1. **Hoàn tất charge đến hạn:** chọn charge `PENDING` có `due_at <= now` bằng `UPDLOCK, READPAST`, đặt trạng thái cuối và ghi `webhook_events` trong cùng transaction (trừ `webhook=drop`).
2. **Gửi webhook đến hạn:** chọn sự kiện `PENDING` có `next_attempt_at <= now` bằng `UPDLOCK, READPAST`, gửi, rồi ghi kết quả và lịch retry.

Cách này đồng nhất cho cả trường hợp có và không có `delay`, bền qua restart và an toàn khi chạy nhiều instance. Test dùng `Clock` giả và gọi tay một tick của worker nên không phải chờ thật.

## 6. Dữ liệu và sao kê

### Bảng (DB `billing_payment`)

- **`charges`**: `id`, `reference`, `amount`, `currency`, `status`, `failure_code`, `scenario` (JSON), `due_at`, `created_at`, `completed_at`. Index `(status, due_at)` và `(completed_at, id)`. Ràng buộc `CHECK (amount > 0)`.
- **`idempotency_keys`**: `key` (khóa chính), `request_hash`, `response_status`, `response_body`, `charge_id`.
- **`webhook_events`**: `event_id`, `charge_id`, `type`, `payload`, `status` (`PENDING | DELIVERED | FAILED`), `attempts`, `next_attempt_at`, `duplicate`, `delivered_at`.
- **`webhook_attempts`**: `event_id`, `attempt_no`, `at`, `status_code`, `error`.

Tên cột trong code tránh từ khóa T-SQL nên khác một chút so với danh sách trên: `idempotency_keys.idempotency_key`, `webhook_events.event_type`, `webhook_events.send_twice`, `webhook_attempts.attempted_at`, `webhook_attempts.error_message`.

Migration đầu tiên của billing nằm ở `db/payment/`, chạy bằng script `corepack pnpm db:migrate:payment` dùng migrator của Kysely; chạy được trên container test và trên DB thật.

### `GET /settlements?date=YYYY-MM-DD`

- Lấy mọi charge có `completed_at` trong `[date 00:00, date+1 00:00)` theo UTC, sắp theo `(completed_at, id)`.
- Mỗi dòng: `chargeId`, `reference`, `amount`, `currency`, `status`, `failureCode?`, `completedAt`.
- Kèm tổng kiểm theo `currency` và `status`: `{ count, totalAmount }`. Tổng kiểm luôn tính trên toàn ngày, không theo trang.
- Phân trang bằng `limit` (mặc định 500, tối đa 1000) và `cursor` theo `(completed_at, id)`.
- `date` sai định dạng hoặc thuộc tương lai trả `400`. Ngày chưa có charge trả danh sách rỗng và tổng bằng 0.

## 7. Cấu hình

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng HTTP | `3002` |
| `PAYMENT_DB_HOST`, `PAYMENT_DB_PORT`, `PAYMENT_DB_NAME`, `PAYMENT_DB_USER`, `PAYMENT_DB_PASSWORD` | Kết nối SQL Server | không có (bắt buộc) |
| `WEBHOOK_URL` | Endpoint nhận webhook | không có (bắt buộc) |
| `WEBHOOK_SECRET` | Khóa ký HMAC | không có (bắt buộc) |
| `WEBHOOK_BACKOFF` | Các mốc retry (giây) | `1,5,30,120,600` |
| `WORKER_INTERVAL_MS` | Chu kỳ poll của worker | `500` |
| `RESPONSE_TIMEOUT_MS` | Thời gian giữ phản hồi cho `response=timeout` | `30000` |

`PAYMENT_DB_PORT` mặc định `1433`. Dung sai thời gian khi kiểm chữ ký là tham số phía nhận (`verifyWebhook`, mặc định 300 giây, trong `@billing/contracts`) nên payment không có biến này. Mỗi sự kiện được "chiếm" riêng bằng lease 60 giây ngay trước khi gửi (lease chỉ cần phủ một lần gửi; vòng lặp tối đa `limit` sự kiện mỗi tick) để không gửi trùng giữa hai worker; nếu tiến trình chết, sự kiện tự đến hạn lại sau lease (xem ADR-0005).

Thiếu biến bắt buộc thì service từ chối khởi động. Không có giá trị mặc định cho bí mật.

## 8. Kiểm thử

| Tầng | Nội dung |
|---|---|
| Unit | `Charge` (máy trạng thái), `Scenario` (phân tích, từ chối giá trị lạ, loại trừ `drop`/`duplicate`), chữ ký HMAC (đúng, sai, lệch thời gian), backoff |
| Integration | Use case với SQL Server thật qua testcontainers và `Clock` giả: tạo charge; idempotency (trùng nội dung, khác nội dung `422`, hai request đồng thời); hoàn tất đến hạn; retry rồi `FAILED`; `webhook=drop` và `duplicate`; sao kê đúng theo ngày, phân trang và tổng kiểm |
| API | Route Fastify bằng `inject`: `400` / `202` / `404` / `422`, header, `response=timeout` |
| Restart | Dựng lại service giữa chừng; webhook chưa gửi vẫn được gửi sau đó |

Package `@billing/testing` (testcontainers SQL Server, receiver webhook giả) được tạo ở bước này vì đây là nơi đầu tiên cần đến nó. Test integration cần Docker.

## 9. Ngoài phạm vi (YAGNI)

Hoàn tiền và hủy charge, nhiều endpoint webhook, `callbackUrl` theo request, API quản trị lập kịch bản, xác thực người gọi `POST /charges`, hết hạn idempotency key, tiền tệ ngoài `VND` và `USD`.

## 10. Phụ thuộc và câu hỏi mở (không chặn spec này)

- Instance SQL Server dùng chung cho DB billing chưa chốt (xem ADR-0004); bước này dùng container test nên không bị chặn, nhưng cần chốt trước Wallet core.
- Wallet (bước 3) sẽ là người nhận webhook thật; địa chỉ endpoint và việc cấp `WEBHOOK_SECRET` chung được chốt ở bước 3.
