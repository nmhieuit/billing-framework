# Bước 4 — Tích hợp order: thiết kế

**Ngày:** 2026-10-10
**Trạng thái:** Chờ duyệt
**Phạm vi:** Wallet nhận yêu cầu thu tiền order từ ecommerce qua RabbitMQ, trừ ví, và báo kết quả bằng event qua outbox; hợp đồng event, Pact và Pact Broker. Chỉ phía billing; phần việc của ecommerce được bàn giao bằng tài liệu. Dựa trên spec nền tảng (`2026-10-09-billing-framework-design.md`, mục 4–5) và wallet core (`2026-10-10-wallet-core-design.md`).

## 1. Mục tiêu và quyết định đã chốt

Khi order hoàn tất ở ecommerce, wallet trừ số dư của khách để trả order một cách bất đồng bộ, rồi ecommerce chuyển order `Unpaid → Paid`. Không bao giờ trừ tiền hai lần cho một order, dù message bị giao lại, gửi trùng hoặc hai consumer chạy song song.

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Phạm vi | Chỉ phía billing. Phần ecommerce (C#: `Unpaid`/`Paid`, publish, consume) là spec/plan riêng ở repo ecommerce, bàn giao bằng tài liệu |
| 2 | Hình dạng message | JSON phẳng theo quy ước event của ecommerce (`eventId`, `occurredAtUtc`, `tenantId`, `correlationId` + trường nghiệp vụ), không có envelope; version nằm trong tên event. Mục "Envelope chung" của spec nền tảng được sửa cho khớp |
| 3 | Broker | Hai exchange `orders.events` và `billing.events` cùng nằm trong vhost `billing` của RabbitMQ dùng chung; mỗi bên một user có quyền theo exchange |
| 4 | Hợp đồng | JSON Schema (`packages/contracts`) là chốt chặn ở mỗi bên + Pact message hai chiều qua **Pact Broker dựng trong bước này** (compose overlay + các bước Jenkins, chưa có manifest K8s) |
| 5 | Thiếu tiền | Từ chối ngay bằng `OrderPaymentFailedV1(INSUFFICIENT_FUNDS)`, order giữ `Unpaid`; kết quả thất bại không bị ghi nhớ nên xét lại được khi ecommerce gửi lại yêu cầu |
| 6 | Outbox | Module riêng của wallet, nằm trong từng schema tenant (không phải package dùng chung vì chỉ wallet dùng) |
| 7 | `packages/messaging` | Bọc `amqplib`: topology, publisher có confirm, consumer có retry/DLQ. Dùng chung được |

## 2. Hợp đồng event

Ba event mới, JSON phẳng, camelCase. Tên kiểu `{Event}V{N}`, schema `{Event}.v{N}.schema.json` (JSON Schema 2020-12) đặt ở `packages/contracts`, bất biến sau khi phát hành. Trường chung (bắt buộc): `eventId` (UUID), `occurredAtUtc` (ISO 8601 UTC), `tenantId`, `correlationId`.

| Event | Phát → nhận | Routing key | Trường nghiệp vụ (bắt buộc) |
|---|---|---|---|
| `OrderReadyForPaymentV1` | orders → wallet | `order-ready-for-payment.v1` | `orderId` (UUID), `customerId`, `amount` (số nguyên ≥ 1, minor unit), `currency` (`VND`\|`USD`) |
| `OrderPaidV1` | wallet → orders | `order-paid.v1` | `orderId`, `walletTransactionId`, `amount`, `currency`, `paidAtUtc` |
| `OrderPaymentFailedV1` | wallet → orders | `order-payment-failed.v1` | `orderId`, `reason` ∈ {`INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`} |

- Người nhận theo "tolerant reader": bỏ qua trường lạ; thêm trường tùy chọn là tương thích; đổi nghĩa hoặc thêm trường bắt buộc thì ra `V2` chạy song song.
- `OrderReadyForPaymentV1` do billing đề xuất (consumer-driven); ecommerce đưa vào `shared/EventContracts` của họ và Pact giữ hai bên đồng nhất. Khác `total decimal` của `OrderPlacedV1`: `amount` là số nguyên minor unit kèm `currency`; adapter phía ecommerce đổi.
- `eventId` của event wallet phát là UUID mới mỗi lần phát; phát lại `OrderPaidV1` cho order đã trả vẫn giữ nguyên `walletTransactionId`. `correlationId` lấy từ event nhận.
- Thuộc tính AMQP: `contentType = application/json`, `messageId = eventId`, `type =` tên event (ví dụ `OrderPaidV1`), `deliveryMode = persistent`, header `x-correlation-id`.

## 3. Broker và `@billing/messaging`

### Topology (vhost `billing`)

- Exchange topic bền: `orders.events`, `billing.events` (khai báo bởi script init, không bởi service).
- Wallet: queue `wallet.order-payments` gắn vào `orders.events` với key `order-ready-for-payment.v1`.
- Retry: wallet tự khai báo hai exchange `direct` bền `wallet.work` và `wallet.retry` (tiền tố `wallet.` nằm trong quyền configure). Queue chính gắn vào `wallet.work` (key `order-payments`) và vào `orders.events`. Mỗi bậc backoff một queue `wallet.order-payments.retry.<giây>` gắn vào `wallet.retry` (key `retry.<giây>`), đặt `x-message-ttl` và dead-letter về `wallet.work`; hết bậc thì publish vào `wallet.retry` với key `dlq` tới queue `wallet.order-payments.dlq`. Mặc định bậc `5,30,120,600,1800` giây (`ORDER_RETRY_DELAYS`; tổng ~43 phút trước khi vào DLQ). **Không dùng default exchange** (`amq.default`) làm DLX hay để publish: quyền ghi `amq.default` cho phép ghi vào mọi queue trong vhost, mâu thuẫn với bảng quyền bên dưới (đã kiểm chứng bằng probe).
- Ecommerce tự khai báo queue của họ (tiền tố `ecommerce.`) gắn vào `billing.events` với key `order-paid.v1` và `order-payment-failed.v1`.

### Quyền (script `deploy/scripts/init-rabbitmq.sh`)

| User | configure | write | read |
|---|---|---|---|
| `billing_wallet` | `^wallet\..*` | `^(billing\.events\|wallet\..*)$` | `^(orders\.events\|wallet\..*)$` |
| `billing_payment` | (không dùng RabbitMQ ở bước này; thu hẹp xuống không quyền) | | |
| `ecommerce_orders` (mới) | `^ecommerce\..*` | `^(orders\.events\|ecommerce\..*)$` | `^(billing\.events\|ecommerce\..*)$` |

### Gói `@billing/messaging`

- `declareTopology(channel, spec)`: khai báo idempotent exchange/queue/binding/retry/DLQ.
- `Publisher`: publish JSON với thuộc tính ở mục 2, dùng confirm channel và cờ `mandatory`. Message không có queue nào nhận (broker trả `NO_ROUTE`) bị coi là **thất bại**, không phải thành công: broker vẫn confirm các message không định tuyến được, và nếu không đặt `mandatory` thì chúng bị bỏ lặng lẽ (đã kiểm chứng). Dòng outbox khi đó giữ `PENDING` và được thử lại, nên khi ecommerce chưa khai báo queue thì không mất kết quả. Trả lỗi rõ khi broker nack hoặc mất kết nối.
- `Consumer`: prefetch cấu hình được (`ORDER_CONSUMER_PREFETCH`, mặc định 10); handler trả `ack`, `retry` hoặc `reject`; `retry` đẩy sang bậc tiếp theo (đếm bằng header `x-retry-count`), hết bậc thì sang DLQ; `reject` vào DLQ ngay. Tự kết nối lại; dừng êm chờ message đang xử lý.
- Không import code domain của service; chỉ phụ thuộc `amqplib`.

## 4. Thanh toán order trong wallet

### Dữ liệu (migration `003` cho mỗi schema tenant)

- Ràng buộc loại giao dịch ledger mở rộng thành `('TOPUP', 'ORDER_PAYMENT')`.
- `order_payments(order_id PK, customer_id, wallet_transaction_id, amount, currency, paid_at)` — chỉ lần trả **thành công** mới có dòng.
- `outbox(id PK = eventId, event_type, routing_key, payload nvarchar(max), correlation_id, status 'PENDING'|'SENT', attempts, next_attempt_at, created_at, sent_at)` kèm index `(status, next_attempt_at, id)` cho `top (1) … updlock, readpast`.

### Use case `PayOrder`

Một transaction của schema tenant (tenant lấy từ `tenantId` trong event qua `TenantRegistry`):

1. Ghi inbox `("orders-events", eventId)`; trùng khóa thì rollback và ack.
2. Tra `order_payments` theo `orderId`:
   - đã trả, cùng số tiền và đồng tiền → ghi outbox `OrderPaidV1` với `walletTransactionId` cũ, **không trừ thêm**;
   - đã trả, khác số tiền hoặc đồng tiền → ghi outbox `OrderPaymentFailedV1(CONFLICT)`, log cảnh báo.
3. Chưa trả: không có ví → `WALLET_NOT_FOUND`; khác đồng tiền → `CURRENCY_MISMATCH`; khóa ví và tài khoản `MERCHANT` (UPDLOCK, id tăng dần); số dư không đủ → `INSUFFICIENT_FUNDS`. Mọi nhánh từ chối chỉ ghi outbox `OrderPaymentFailedV1`.
4. Đủ tiền: ví `−X`, `MERCHANT +X`; giao dịch ledger `ORDER_PAYMENT` với `business_key = order:<orderId>` (duy nhất); thêm `order_payments`; ghi outbox `OrderPaidV1`.

Nhánh từ chối là kết quả nghiệp vụ hợp lệ: transaction vẫn commit (inbox + outbox), message được ack.

### Chống trùng

| Lớp | Chặn |
|---|---|
| Inbox `("orders-events", eventId)` | Broker giao lại cùng message |
| `order_payments.order_id` + `business_key = order:<orderId>` duy nhất | Yêu cầu lặp với `eventId` khác |
| `UPDLOCK` ví/MERCHANT theo thứ tự id | Hai consumer cùng trừ một ví |
| `CHECK (balance >= 0)` ở DB | Lỗi code lọt qua |
| Khử trùng ở bên nhận theo `eventId` | Relay giao lại outbox |

### Consumer của wallet

Đăng ký handler cho `wallet.order-payments`. Phân loại kết quả:

- Message không phải JSON, sai schema `OrderReadyForPaymentV1`, hoặc `tenantId` không thuộc `WALLET_TENANTS` → `reject` (DLQ), kèm log lỗi (không ghi bí mật).
- `PayOrder` hoàn tất (kể cả nhánh từ chối nghiệp vụ) → `ack` sau khi commit.
- Lỗi tạm (mất kết nối DB, deadlock…) → `retry` theo bậc backoff, hết bậc → DLQ.

### Relay outbox

Một tác vụ trong `Worker` hiện có, duyệt từng tenant (lỗi một tenant không chặn tenant khác, có `shouldContinue`): mỗi lần chiếm **một** dòng `PENDING` đến hạn bằng lease 60 giây, publish ra `billing.events` có confirm (ngoài transaction), rồi đánh dấu `SENT`. Lỗi publish → `attempts + 1`, hẹn lại theo backoff; không bao giờ bỏ dòng. Giao ít nhất một lần; thứ tự giữa các order không được đảm bảo. Dừng service chờ lần publish đang chạy rồi mới đóng kết nối.

### Cấu hình mới (thêm vào `loadConfig` và `services/wallet/.env.example`)

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_VHOST`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | Kết nối broker | host/user/password bắt buộc; cổng `5672`; vhost `billing` |
| `ORDER_CONSUMER_PREFETCH` | Số message xử lý đồng thời | `10` |
| `ORDER_RETRY_DELAYS` | Các bậc retry của consumer (giây) | `5,30,120,600,1800` |
| `OUTBOX_BATCH` | Số dòng outbox tối đa mỗi tenant mỗi lượt | `50` |

Thiếu hoặc sai thì từ chối khởi động và liệt kê mọi vấn đề cùng lúc (như `loadConfig` hiện tại). Mật khẩu RabbitMQ không có giá trị mặc định và không bao giờ vào log.

## 5. Pact, Pact Broker, CI

### Quan hệ Pact (message pact, `@pact-foundation/pact`)

| Event | Consumer | Provider | Viết pact | Verify |
|---|---|---|---|---|
| `OrderReadyForPaymentV1` | `wallet` | `orders` | billing (test consumer của wallet) | ecommerce |
| `OrderPaidV1`, `OrderPaymentFailedV1` | `orders` | `wallet` | ecommerce | billing (dựng message thật từ `PayOrder` và outbox) |

Message do mỗi bên tạo hoặc đọc còn phải qua JSON Schema của `packages/contracts`, nên hợp đồng vẫn có hiệu lực khi một bên chưa nối broker.

### Pact Broker

- `deploy/compose.pact-broker.yml`: `pactfoundation/pact-broker` + Postgres riêng (volume, mật khẩu qua `deploy/.env`, không có giá trị mặc định cho bí mật), chạy được ở local và trong test.
- Jenkinsfile của billing thêm các bước: publish pact của wallet, verify provider wallet, `can-i-deploy`. Chỉ chạy khi job/folder Jenkins định nghĩa biến môi trường `PACT_BROKER_BASE_URL` (không phải tham số build, để không ai chuyển được credential cố định `pact-broker` tới host tùy ý); image `pact-cli` ghim theo digest; nếu chưa có thì bỏ qua và ghi log rõ, để build không vỡ trước khi broker thật sẵn sàng.
- Ngoài phạm vi: manifest K8s của broker (hạ tầng chung/Bước 6) và việc ecommerce nối CI của họ vào broker.

### Tài liệu bàn giao cho ecommerce (`docs/integration/orders-handoff.vi.md`)

1. Thêm trạng thái `Unpaid`/`Paid` cho Order; chỉ `Unpaid → Paid` khi nhận `OrderPaidV1`, bỏ qua nếu đã `Paid`. `Paid` là trạng thái cuối.
2. Publish `OrderReadyForPaymentV1` qua outbox khi order hoàn tất; đổi `total` thành `amount` minor unit kèm `currency`.
3. Consume `billing.events` (hai event); `OrderPaymentFailedV1` ghi lý do và giữ `Unpaid`, và **phải bị bỏ qua nếu order đã `Paid`** (có thể đến sau `OrderPaidV1`, ví dụ `CONFLICT` sau lần gửi lại khác chi tiết). Kết quả của cùng một `orderId` có thể đến không theo thứ tự và nhiều lần: áp dụng theo trạng thái, không theo thứ tự đến. Message hết bậc retry vì sự cố hạ tầng vào DLQ mà không có phản hồi; publish lại cùng `orderId` với `eventId` mới là an toàn (`docs/integration/dlq-runbook.vi.md`).
4. Cấu hình MassTransit gửi JSON thuần vào vhost `billing` với user `ecommerce_orders`.
5. Đưa schema vào `shared/EventContracts` (test bất biến), viết và verify Pact, nối broker.

## 6. Kiểm thử

| Tầng | Nội dung |
|---|---|
| Unit | Schema 3 event (hợp lệ/không hợp lệ), `LedgerTransaction.orderPayment`, phân loại kết quả consumer, config mới |
| Integration (SQL Server + RabbitMQ thật) | `PayOrder` đủ nhánh (thành công, thiếu tiền, không ví, khác đồng tiền, lặp cùng số tiền, khác số tiền, retry sau khi nạp thêm); relay outbox; `@billing/messaging` (confirm, prefetch, retry, DLQ) |
| Đồng thời / chaos | Cùng một message N lần song song → đúng 1 bút toán; kill consumer sau commit, trước ack → vẫn 1 bút toán; kill relay giữa chừng → giao lại, bên nhận dedup |
| Contract | Pact hai chiều với broker thật dựng bằng container; message qua JSON Schema |
| E2E | "Orders giả" publish `OrderReadyForPaymentV1`, đợi `OrderPaidV1`/`OrderPaymentFailedV1`; kiểm số dư và sổ cái; bất biến tổng số dư bằng 0 vẫn đúng |

## 7. Kế hoạch task dự kiến

1. Contracts: 3 schema + validator; sửa mục envelope của spec nền tảng. 2. `@billing/testing`: container RabbitMQ. 3. `@billing/messaging`: topology, publisher, consumer. 4. Domain `ORDER_PAYMENT` và migration `003`. 5. Repository `order_payments`, `outbox`. 6. `PayOrder`. 7. Relay outbox. 8. Consumer của wallet, cấu hình, nối dây. 9. E2E có RabbitMQ thật và "orders giả" (gồm đồng thời và chaos). 10. Pact phía wallet (consumer và provider). 11. Pact Broker compose, các bước Jenkins, `can-i-deploy`. 12. Script init RabbitMQ (user ecommerce, exchange), ADR, README. 13. Tài liệu bàn giao. 14. Kiểm chứng toàn bộ.

## 8. Ngoài phạm vi

Code phía ecommerce; manifest K8s của Pact Broker; đối soát Wallet ↔ Orders (Bước 5); feature flag Unleash; hoàn tiền; thứ tự xử lý đảm bảo giữa các order.

## 9. Rủi ro cần kiểm chứng sớm và câu hỏi mở

- **Đã kiểm chứng bằng probe thật** (RabbitMQ 3 qua testcontainers, `amqplib` 2.2.0, `@pact-foundation/pact` 17.1.4, Pact Broker + Postgres, SQL Server 2022): publisher confirm và `mandatory`/`return`; retry theo bậc TTL, DLQ và header `x-retry-count`; phạm vi quyền của user wallet và ecommerce (xem lưu ý về `amq.default` ở mục 3); message pact chạy dưới Vitest (mặc định spec 3.0.0, khớp PactNet 5 của ecommerce) và verify provider từ broker kèm publish kết quả; `can-i-deploy` trả "không" khi chưa verify và "có" sau khi verify; `ALTER TABLE … DROP CONSTRAINT` rồi `ADD CONSTRAINT … CHECK` trên bảng đã có dữ liệu và trigger bất biến, ràng buộc vẫn tin cậy (`is_not_trusted = 0`).
- `globalSetup` của test tích hợp dựng thêm RabbitMQ song song với SQL Server (không tăng thời gian chờ đáng kể); Pact Broker và Postgres chỉ chạy khi kiểm tay hoặc ở bước Jenkins, không nằm trong `globalSetup`.
- Ecommerce hiện chưa có consumer/publisher RabbitMQ thật (ADR-0011 của họ), MassTransit ghim 8.x: cách cấu hình gửi JSON thuần cần xác nhận cùng team ecommerce.
- Danh sách tenant của gateway ecommerce và `WALLET_TENANTS` phải khớp (mở từ Bước 3); instance RabbitMQ dùng chung và cách truy cập từ máy phát triển (ADR-0004).
