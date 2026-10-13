# Manual test plan: Thanh toán order bất đồng bộ (RabbitMQ)

> **Giai đoạn 2, nhóm C.** Ecommerce báo order hoàn tất qua RabbitMQ; wallet trừ ví đúng một lần cho mỗi `orderId` rồi báo kết quả (`docs/integration/orders-handoff.vi.md`).
> Môi trường: **local stack** (`deploy/compose.local.yml`). Quan sát bằng **log và Kibana** (đã xác nhận). Được phép tạm dừng `wallet`/`payment` và ghi dữ liệu (đã xác nhận).
> Mọi "kết quả mong đợi" **đọc từ code và tài liệu tích hợp, chưa chạy thật**; cột "Cơ sở" trỏ file. Chỗ chưa chắc ghi **[Chưa xác minh]**.
> Ecommerce **không có trong repo/stack local**: QA đóng vai ecommerce, publish thủ công qua RabbitMQ management (đã được cho phép đặt header; cách publish tay là giả định cần bạn xác nhận khi chạy).

## 1. Luồng và hợp đồng

```text
(QA đóng vai orders) ── OrderReadyForPaymentV1 ──▶ exchange orders.events ──▶ queue wallet.order-payments ──▶ wallet
(QA đọc) ◀── OrderPaidV1 / OrderPaymentFailedV1 ◀── exchange billing.events ◀── wallet (qua outbox)
```

| Mục | Giá trị | Nguồn |
| --- | --- | --- |
| vhost | `billing` | `deploy/scripts/init-rabbitmq.sh` |
| Exchange vào | `orders.events` (topic), routing key `order-ready-for-payment.v1` | `docs/integration/orders-handoff.vi.md` (bảng Hợp đồng); `tools/local/seed.ts:8-9` |
| Exchange ra | `billing.events`; key `order-paid.v1`, `order-payment-failed.v1` | như trên |
| Queue làm việc của wallet / DLQ | `wallet.order-payments` / `wallet.order-payments.dlq` | `order-payments.topology.ts`; `docs/integration/dlq-runbook.vi.md` |
| Backoff retry khi lỗi hạ tầng | `ORDER_RETRY_DELAYS=5,30,120,600,1800` giây (≈ 43 phút) | `services/wallet/.env.example:32` |
| Schema `OrderReadyForPaymentV1` | `eventId` (UUID), `occurredAtUtc` (date-time), `tenantId` (1..64), `correlationId` (1..100), `orderId` (UUID), `customerId` (1..64), `amount` (số nguyên 1..9007199254740991), `currency` (`VND`/`USD`); trường lạ được bỏ qua | `packages/contracts/src/events.ts:5-39`; handoff |
| Lý do thất bại | `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`, `WALLET_FROZEN` | `events.ts` (enum `reason`) |
| RabbitMQ management | `http://localhost:15674` (đổi bằng `LOCAL_RABBITMQ_MGMT_PORT`), tài khoản quản trị là `BILLING_RABBITMQ_ADMIN_USER/PASSWORD` trong `deploy/.env` | `docs/ops/local-stack.vi.md` |

**Thực thi (từ code):** handler giải mã body, kiểm schema, tra tenant rồi gọi `PayOrder`. Kết quả nghiệp vụ (kể cả từ chối) luôn `ack`, kết quả nằm trong outbox cùng transaction; message hỏng hoặc tenant lạ bị `reject` vào DLQ; lỗi hạ tầng thì `retry` (`order-ready.handler.ts:1-69`). `PayOrder` chạy theo thứ tự: inbox theo `eventId`, đã trả theo `orderId`, ví và đồng tiền, khóa ví + MERCHANT, ví đóng băng, đủ tiền (`pay-order.ts`).

## 2. Chuẩn bị chung

1. Stack lên và khỏe (`GET :3001/health`, `:3002/health`); các job `*-init` và `migrate` thoát mã 0 (`docs/ops/local-stack.vi.md`).
2. **Tạo queue nhận kết quả của "ecommerce"** (bắt buộc: wallet publish kiểu `mandatory`, nếu chưa có queue nào gắn vào `billing.events` thì wallet giữ lại kết quả và thử lại 1/5/30/120/600 s; `orders-handoff.vi.md`, mục Broker). Trong management: Queues → Add a new queue, vhost `billing`, tên `ecommerce.qa-results` (tiền tố `ecommerce.` theo quy ước), Durable; rồi trang queue → Bindings: from `billing.events`, routing key `order-paid.v1`; thêm lần nữa với `order-payment-failed.v1`. (Cách khác: `pnpm local:seed` tự tạo queue `ecommerce.billing-events` gắn `#`, `tools/local/seed.ts:12`, nhưng seed tạo luôn ví, topup, đối soát; xem ORD-S01.)
3. **Ví và số dư để test:** dùng API wallet như nhóm A (`01-manual-wallet-core.md`): tạo ví `VND`, nạp tiền, chờ `SUCCEEDED`. Mỗi test dùng **customer id mới** (ví dụ `ord-c001`) và ghi số dư trước/sau.
4. **Cách publish `OrderReadyForPaymentV1`:** management → Exchanges → `orders.events` → Publish message: Routing key `order-ready-for-payment.v1`; Properties: `content_type=application/json`, `message_id=<eventId>`, `type=OrderReadyForPaymentV1` (giống seed, `tools/local/seed.ts:179-184`; handler không dùng bắt buộc `type`/`message_id` **[Chưa xác minh]** nếu thiếu thì sao); Payload:

```json
{"eventId":"<uuid mới>","occurredAtUtc":"2026-10-13T08:00:00Z","tenantId":"acme","correlationId":"qa-ord-001","orderId":"<uuid>","customerId":"ord-c001","amount":100000,"currency":"VND"}
```

   Sinh UUID bằng `uuidgen`. Mỗi lần publish dùng `eventId` **mới** (trừ test cố ý gửi trùng).
5. **Đọc kết quả:** management → Queues → `ecommerce.qa-results` → Get messages (Ack mode: *Automatic ack* để lấy hết, hoặc *Nack message requeue true* nếu muốn giữ). Hoặc log wallet: `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet | grep "order payment handled"` (log có `orderId`, `eventId`, `outcome`, `reason`; `order-ready.handler.ts:63-72`).
6. Sau khi publish, **chờ vài giây**: kết quả qua outbox rồi relay mới ra broker; độ trễ thực tế **[Chưa xác minh]** (đọc `relay-outbox` khi chạy). Nếu quá ≈ 10 s, xem `billing.outbox.pending` trên Kibana.

## 3. Phân loại: manual hay tự động hóa

| Phần | Manual (nên) | Tự động hóa sau | Lý do |
| --- | --- | --- | --- |
| Một lượt đi qua stack thật (publish, ví bị trừ, kết quả ra broker) | **Có** | Script AMQP trong CI (đã có test in-process: `services/wallet/src/order-payment.integration.test.ts`) | Cần kiểm hạ tầng và cấu hình thật (user, exchange, binding) |
| Các nhánh từ chối nghiệp vụ | Một lượt đầu | Test integration đã có | Rẻ nhưng cần thấy kết quả thực trên broker |
| Idempotency và concurrency | **Có** (đặc biệt ORD-017) | Test integration đã có | Rủi ro tiền bạc cao |
| DLQ, retry, dừng/khởi động wallet | **Có** | Khó tự động hóa trên stack thật | Cần thao tác hạ tầng và đọc header tay |
| Cảnh báo/dashboard Kibana | **Có** | `pnpm kibana:verify` chỉ kiểm rule/dashboard tồn tại và truy vấn chạy được | Cần nhìn trạng thái cảnh báo thực |

## 4. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**. "Số dư" là `GET /wallet` của khách (`01-manual-wallet-core.md`).

### 4.1 Happy path và idempotency

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ORD-001 | **Trả order thành công end-to-end** | Chuẩn bị mục 2; ví `ord-c001` `VND`, số dư 150000; queue `ecommerce.qa-results` đã gắn | Publish order `amount:100000` (`orderId` mới, `eventId` mới) | (1) Sau vài giây số dư = **50000**; (2) Có đúng **1** message `order-paid.v1` trong `ecommerce.qa-results` với cùng `orderId`, `amount:100000`, `currency:"VND"`, `walletTransactionId` (dạng `tx_...`), `paidAtUtc`, `tenantId:"acme"`, `correlationId:"qa-ord-001"` (nguyên văn từ yêu cầu); (3) `GET /wallet/entries` có entry mới `-100000` **[Chưa xác minh]** dấu/`businessKey` (`order:<orderId>` theo `dlq-runbook.vi.md`, mục "Vì sao an toàn"); (4) log wallet `outcome: PAID` | P1 | S | `pay-order.ts:120-177`; `events.ts` `orderPaidV1`; handoff |
| ORD-002 | Gửi lại cùng `orderId`, `eventId` mới: không trừ thêm, phát lại `OrderPaidV1` | Sau ORD-001 | Publish lại cùng `orderId`/khách/số tiền với `eventId` mới | Số dư **không đổi** (50000); có message `order-paid.v1` mới với **cùng `walletTransactionId`** nhưng `eventId` mới; log `outcome: REPLAYED` | P1 | S | `pay-order.ts:87-117`; handoff mục Quy tắc nghiệp vụ |
| ORD-003 | Gửi lại **cùng `eventId`**: bị khử trùng, không phản hồi | Sau ORD-001 | Publish lại **nguyên văn** message ORD-001 (cùng `eventId` và `orderId`) | Số dư không đổi; **không** có message kết quả mới; log `outcome: DUPLICATE` | P1 | R | `pay-order.ts:61,83` (`inbox`) |
| ORD-004 | Cùng `orderId`, khác số tiền | Sau ORD-001 | Publish cùng `orderId`, `amount:90000`, `eventId` mới | `order-payment-failed.v1` với `reason:"CONFLICT"`; số dư không đổi; log cảnh báo "order already paid with different details" | P1 | R | `pay-order.ts:87-98` |
| ORD-005 | Cùng `orderId`, khác khách | Sau ORD-001; có ví khách `ord-c002` | Publish cùng `orderId`, `customerId:"ord-c002"` | `CONFLICT`; không ví nào bị trừ | P1 | R | `pay-order.ts:87-98` |
| ORD-006 | Gửi đồng thời cùng `orderId` | Ví đủ tiền cho 1 lần | Publish nhanh 5 message cùng `orderId` (cùng khách, số tiền), mỗi cái `eventId` khác | Ví bị trừ **đúng 1 lần**; cả 5 đều ra kết quả (`order-paid.v1`, một `walletTransactionId` duy nhất); có thể 1 `PAID` + 4 `REPLAYED` | P1 | R | `pay-order.ts:56-64` (bên thua chạy lại 1 lần); `dlq-runbook.vi.md` (mục "Vì sao an toàn") |
| ORD-007 | Cô lập tenant | Cùng `customerId` `ord-c010` ở `acme` (số dư 100000) và `beta` (số dư 0) | Publish order 50000 với `tenantId:"beta"` | `order-payment-failed.v1` (`INSUFFICIENT_FUNDS`) cho `beta`; ví `acme` không đổi | P1 | R | `order-ready.handler.ts` (tra tenant); ADR-0006 |

### 4.2 Các nhánh từ chối nghiệp vụ

Mỗi nhánh: message **được ack**, kết quả `OrderPaymentFailedV1` ra qua outbox, **không** vào DLQ, **không** có thay đổi số dư.

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ORD-010 | Không đủ tiền | Ví số dư 50000 | Publish order `amount:100000` | `order-payment-failed.v1`, `reason:"INSUFFICIENT_FUNDS"`; số dư 50000; log `outcome: REJECTED reason: INSUFFICIENT_FUNDS` | P1 | S | `pay-order.ts:140-143` |
| ORD-011 | Wallet không ghi nhớ lần từ chối: nạp thêm rồi thử lại cùng `orderId` | Sau ORD-010 | Nạp thêm 100000; publish lại **cùng `orderId`**, `eventId` mới | Thành công `PAID`, số dư = 50000 + 100000 - 100000 = **50000** | P1 | R | handoff ("wallet không ghi nhớ lần từ chối") |
| ORD-012 | Khách chưa có ví | `customerId` `ord-nowallet` chưa tạo ví | Publish order | `WALLET_NOT_FOUND` | P1 | R | `pay-order.ts:124` |
| ORD-013 | `customerId` không hợp lệ cho ví | — | Publish `customerId:"bad id!"` (schema cho phép 1..64 ký tự tuỳ ý) | `WALLET_NOT_FOUND` (không phải DLQ) | P2 | R | `pay-order.ts:35-42,120-121`; `events.ts` (`customerId` chỉ giới hạn độ dài) |
| ORD-014 | Sai đồng tiền | Ví `VND` | Publish order `currency:"USD"` | `CURRENCY_MISMATCH`; số dư không đổi | P1 | R | `pay-order.ts:125` |
| ORD-015 | Ví đóng băng | Ví đủ tiền; được phép dùng API ops (đã xác nhận ghi dữ liệu) | (1) `curl -X POST $W/ops/wallets/ord-c015/freeze -H 'x-actor-id: qa' -H 'x-actor-role: OPS' -H 'x-tenant-id: acme' -H 'content-type: application/json' -d '{"reason":"qa test","idempotencyKey":"qa-freeze-1"}'`; (2) publish order | `WALLET_FROZEN`; số dư không đổi | P1 | R | `pay-order.ts:136`; `docs/ops/ops-tools.vi.md` (header và body) |
| ORD-016 | Mở băng rồi gửi lại cùng `orderId` | Sau ORD-015 | `POST .../unfreeze` (key mới), publish lại cùng `orderId` với `eventId` mới | `PAID`, ví bị trừ | P1 | R | handoff (cảnh báo `WALLET_FROZEN`) |

### 4.3 Message hỏng và hàng đợi chết (DLQ)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DLQ-001 | Body không phải JSON | Chuẩn bị mục 2 | Publish payload `not json` | Message vào `wallet.order-payments.dlq`; **không** có kết quả trả lại; log lỗi "rejecting unreadable order-ready message"; header `x-dead-letter-reason` ("body is not valid JSON") | P1 | R | `order-ready.decoder.ts:9-13`; `order-ready.handler.ts:27-33`; `consumer.ts:94` |
| DLQ-002 | Sai schema | — | Lần lượt publish: thiếu `orderId`; `amount:0`; `amount:100.5`; `currency:"EUR"`; `eventId:"abc"` (không phải UUID); `{"not":"a valid event"}` | Mỗi message vào DLQ với lý do bắt đầu `schema validation failed: ...` | P1 | R | `events.ts` (schema); `order-ready.decoder.ts:14-17`; `tools/local/seed.ts:215-223` (mẫu) |
| DLQ-003 | Tenant wallet không phục vụ | — | Publish `tenantId:"zzz"` hợp lệ về schema | Vào DLQ, lý do `unknown tenant`; không có kết quả trả lại | P1 | R | `order-ready.handler.ts:37-46`; handoff |
| DLQ-004 | Đọc DLQ không mất message | Có message ở DLQ | Management → Queues → `wallet.order-payments.dlq` → Get messages, chế độ **Nack message requeue true** | Đọc được header `x-dead-letter-reason` (và `x-last-error`, `x-retry-count` nếu có); message vẫn còn trong queue | P2 | R | `dlq-runbook.vi.md`; `consumer.ts:24,94,110` |
| DLQ-005 | Đưa message về hàng đợi làm việc | Message lỗi vĩnh viễn trong DLQ | Management → Move messages → `wallet.work`, routing key `order-payments` | Wallet xử lý lại và message quay lại DLQ vì lỗi vẫn còn; số lần/độ trễ **[Chưa xác minh]** (runbook nói quay lại DLQ "sau các bậc retry") | P3 | R | `dlq-runbook.vi.md` mục "Đưa message về hàng đợi làm việc" |
| DLQ-006 | Message cũ không ảnh hưởng xử lý order khác | DLQ có ≥ 1 message | Publish order hợp lệ (ORD-001) | Order vẫn `PAID` bình thường | P2 | R | `consumer.ts` (reject không chặn queue chính) |

### 4.4 Chịu lỗi: dừng wallet, hạ tầng, broker

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RES-001 | Order publish khi wallet đang dừng được xử lý khi wallet lên | Được phép dừng wallet (đã xác nhận); ví đủ tiền | (1) `docker compose -f deploy/compose.local.yml --env-file deploy/.env stop wallet`; (2) publish order; (3) kiểm queue `wallet.order-payments` có message chờ (`Ready ≥ 1`); (4) `start wallet` | Sau khi wallet lên: message được xử lý, ví bị trừ 1 lần, kết quả ra queue nhận; queue làm việc về 0 | P1 | R | `consumer.ts`; `orders-handoff.vi.md` (giao ít nhất một lần) |
| RES-002 | Wallet dừng đúng lúc có kết quả chờ gửi (outbox) | — | Publish order rồi dừng wallet **ngay** (≤ 1 s), `start` lại | Kết quả vẫn được gửi (một lần hoặc có thể trùng); Orders khử trùng theo `eventId` | P2 | R | `relay-outbox` (outbox); handoff ("giao ít nhất một lần") |
| RES-003 | Không có queue nhận kết quả: wallet giữ lại và thử lại | **Cần bạn xác nhận** (làm các test khác sẽ bị ảnh hưởng): xóa queue `ecommerce.qa-results` và mọi queue gắn vào `billing.events` | Publish order; quan sát `billing.outbox.pending` / `billing-outbox-stuck` trên Kibana; tạo lại queue + binding | Số dư đã bị trừ; kết quả chưa ra broker (wallet thử lại 1/5/30/120/600 s); sau khi có queue, kết quả được giao; cảnh báo `billing-outbox-stuck` (high) có thể bật nếu chờ vượt ngưỡng | P3 | R | handoff mục Broker; `docs/ops/kibana-alerts-and-dashboard.vi.md:37` |
| RES-004 | Hết lượt retry khi DB sự cố vào DLQ | **Chưa chạy**: cần dừng container SQL Server (ảnh hưởng cả payment) ≈ 43 phút. Hỏi bạn trước khi làm | — | Message vào DLQ với lý do dạng `retries exhausted: ...`, ecommerce không nhận phản hồi | P3 | R | `dlq-runbook.vi.md` |

### 4.5 Quan sát: log, dashboard, cảnh báo

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OBS-001 | Metric order_payments theo outcome | Đã chạy vài case 4.1, 4.2 | Kibana (`http://localhost:15601`) → dashboard "Billing: vận hành" (hoặc Discover): xem `metrics.billing.order_payments` theo `attributes.outcome` | Có các outcome tương ứng: `paid`, `replayed`, `duplicate`, `failed:INSUFFICIENT_FUNDS`, `failed:WALLET_FROZEN`... **[Chưa xác minh]** hiển thị đúng trên panel nào | P2 | R | `order-ready.handler.ts:59-62`; `docs/ops/metric-fields.md:19-26` |
| OBS-002 | Cảnh báo `billing-dlq-not-empty` | Có ≥ 1 message ở DLQ (DLQ-001) | Chờ ≈ 5 phút (cửa sổ mặc định) rồi mở Kibana → Rules (tag `billing`) | Rule `billing-dlq-not-empty` (severity `critical`) chuyển active; panel "DLQ depth" > 0 | P1 | R | `docs/integration/dlq-runbook.vi.md` mục Giám sát; `kibana-alerts-and-dashboard.vi.md:36,64` |
| OBS-003 | Cảnh báo hết sau khi dọn DLQ | Sau OBS-002 | Purge hoặc Move hết message khỏi DLQ; chờ vài vòng đánh giá | Rule về trạng thái bình thường sau **một mẫu độ sâu = 0** (rule dùng `MIN` trong cửa sổ) | P2 | R | `dlq-runbook.vi.md` mục Giám sát |
| OBS-004 | Outbox không kẹt khi bình thường | Sau vài order | Dashboard: `billing.outbox.pending` về 0 sau vài giây | Pending không tăng dài hạn | P2 | R | `docs/ops/metric-fields.md:15` |

### 4.6 Smoke bằng seed

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ORD-S01 | Chạy dữ liệu mẫu một lệnh | `deploy/.env` đã có `BILLING_ECOMMERCE_MQ_PASSWORD`; stack lên | `corepack pnpm local:seed` (thêm `-- --with-dlq` để có message hỏng) | Seed tạo ví `seed-1..3` ở các tenant, nạp 500000 VND mỗi ví, publish 3 order mỗi tenant (10.000; 20.000; 10.000.000 VND), chạy đối soát; **đơn 10.000.000 phải bị từ chối `INSUFFICIENT_FUNDS`** (ví 500000) **[Chưa xác minh]** kết quả thực tế | P2 | S | `tools/local/seed.ts:12-16,120-235` |

## 5. Bộ Smoke đề xuất

`ORD-001`, `ORD-002`, `ORD-010`, `ORD-012`, `ORD-015`, `DLQ-003`, `OBS-002`.

## 6. Kết quả thực thi (điền khi chạy)

| ID | Ngày | Người test | Kết quả (Pass/Fail/Blocked) | Giá trị thực tế khi khác mong đợi | Defect |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 7. Câu hỏi còn mở (riêng nhóm này)

1. **Cách publish thay ecommerce**: dùng management UI như mục 2 có ổn không? Hay bạn muốn script (Node `amqplib` như `docs/integration/dlq-runbook.vi.md` mẫu) để gửi nhiều message hoặc đồng thời (ORD-006)?
2. **RES-003** (xóa queue nhận kết quả) và **RES-004** (dừng SQL Server khoảng 43 phút) có được phép không? Cả hai ảnh hưởng các test khác; đề xuất làm sau cùng.
3. **Thuộc tính `message_id`/`type`** khi publish tay: handler dường như không bắt buộc; xác nhận khi chạy.
4. **Độ trễ relay outbox** (từ commit đến kết quả ra broker) chưa đọc; ghi nhận khi chạy.
5. **Ecommerce**: bên ecommerce đã có người xác nhận contract chưa (Pact chưa verify phía ecommerce, nằm ngoài phạm vi theo bạn)?
