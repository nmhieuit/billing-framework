# Ngày 5: Messaging, outbox, retry và DLQ

Khung 4 giờ: Chuẩn bị 20' · Lý thuyết 50' · Đọc code 85' · Thực hành 50' · Thử thách 20' · Kiểm tra 15'.
Nhóm ưu tiên thứ hai: **messaging/outbox/DLQ**.

## Mục tiêu hôm nay
- Vẽ được đường đi của một message: ecommerce → `orders.events` → `wallet.order-payments` → `PayOrder` → outbox → `billing.events`.
- Giải thích **retry theo bậc TTL**, DLQ, và lý do **ack chỉ sau khi commit**.
- Đọc `RelayOutbox` (giao ít nhất một lần) và `startConsumer`.
- Làm được runbook DLQ ở mức khái niệm: xem lý do, quyết định có đưa lại hay không.

## Chuẩn bị
`git switch -c hoc/ngay-5`. Docker Desktop cần cho phần chạy local (CHƯA CHẠY ở môi trường biên soạn).

## Lý thuyết

### 1. Đối chiếu MassTransit (gần đúng)
| Khái niệm | Repo này | MassTransit (tham khảo) |
| --------- | -------- | ----------------------- |
| Thư viện | `amqplib` bọc trong `@billing/messaging` (`BrokerClient`) | MassTransit bọc RabbitMQ.Client |
| Consumer | `MessageHandler` trả `ack` / `retry` / `reject` (`types.ts`) | `IConsumer<T>`; lỗi ném exception |
| Retry | bậc TTL qua queue `...retry.<giây>` (`topology.ts:45-56`) | `UseMessageRetry`/redelivery |
| Hàng đợi lỗi | `<queue>.dlq` (`topology.ts:22,58-60`) | `_error` queue |
| Outbox | bảng `outbox` + `RelayOutbox` tự viết (`relay-outbox.ts`) | transactional outbox của MassTransit |
[GIẢ THUYẾT: cột MassTransit chỉ để định hướng; không có MassTransit trong repo.]

### 2. Contract
Event là **JSON phẳng**, không envelope, có JSON Schema ở `packages/contracts/src/events.ts` (trường chung `eventId`, `occurredAtUtc`, `tenantId`, `correlationId`: dòng 3-8; `amount` là số nguyên, `currency` enum VND/USD: dòng 10-18). `validateEvent` kiểm ở runtime vì kiểu TS bị xóa (Ngày 1). Quyết định: `docs/adr/0008-flat-event-contracts.vi.md` [tác giả chưa đọc ADR].

### 3. Đường đi một message trả order
1. Ecommerce publish `OrderReadyForPaymentV1` lên `orders.events` (exchange do script init tạo, service chỉ kiểm tra bằng passive check — `topology.ts:33-35`).
2. Queue `wallet.order-payments` gắn vào exchange đó (`order-payments.topology.ts:14-16`) và vào `wallet.work` (`:10-11`).
3. Consumer gọi handler `createOrderReadyHandler` (`bootstrap.ts:167,178-182`).
4. Handler giải mã (`decodeOrderReady`), tìm tenant, gọi `PayOrder.execute` (Ngày 4), trả `ack` (`order-ready.handler.ts:25-74`).
5. `PayOrder` ghi **outbox** trong cùng transaction; `RelayOutbox` đọc outbox và publish lên `billing.events` bằng `AmqpEventPublisher` (`amqp-event-publisher.ts:4-19`).

### 4. Quy tắc ack/retry/reject (`order-ready.handler.ts:13-17`)
- Kết quả nghiệp vụ, **kể cả từ chối** → `ack` (kết quả đã nằm trong outbox cùng transaction).
- Message hỏng hoặc tenant lạ → `reject` → vào DLQ ngay (lỗi vĩnh viễn, thử lại vô ích).
- Lỗi hạ tầng (DB, mạng) → để lỗi **lan ra** → consumer biến thành `retry` (`consumer.ts:131-136`).

### 5. Retry theo bậc TTL (`consumer.ts`, `topology.ts`)
- Header `x-retry-count` đếm số lần (`consumer.ts:24,118-121`); header upstream **không được tin** (sai kiểu → coi là 0, vượt số bậc → chặn ở số bậc).
- `retry` (`consumer.ts:98-114`): lấy `delay = retryDelaysSeconds[retryCount]`; còn bậc → `forward` sang `retry.<delay>` rồi `ack` bản gốc; hết bậc → `deadLetter` với lý do `retries exhausted: ...`.
- Queue `<queue>.retry.<s>` có `x-message-ttl` và `x-dead-letter-exchange` về `workExchange` (`topology.ts:47-54`): hết TTL thì message tự quay về queue làm việc.
- Mặc định `ORDER_RETRY_DELAYS=5,30,120,600,1800` giây, tổng ~43 phút (`docs/integration/dlq-runbook.vi.md`).
- Không republish được (kênh chết) → `nack(requeue)` sau độ trễ để không quay vòng nóng (`consumer.ts:154-165`).
- `forward` bỏ các header nguy hiểm (`x-death`, `CC`, `BCC`, token publish): `consumer.ts:28-42`.

### 6. Outbox và giao "ít nhất một lần"
`RelayOutbox.executeNextDue` (`relay-outbox.ts:42-87`): (1) **chiếm** một dòng bằng lease trong transaction ngắn; (2) **publish ngoài transaction**; (3) ghi kết quả trong transaction mới (`markSent` hoặc `recordFailure` hẹn lại theo backoff `1,5,30,120,600` giây — `relay-outbox.ts:4`). Chết giữa bước 2 và 3 → gửi lại sau khi lease hết (60 giây, `:6`). **Hệ quả bắt buộc**: bên nhận phải khử trùng theo `eventId`. `publish` có `confirm` và `mandatory`: không định tuyến được → `unroutable` → log cảnh báo, thử lại (`publisher.ts:9-13`, `relay-outbox.ts:75-78`).

## Đọc code có hướng dẫn
1. `packages/messaging/src/types.ts` — `HandlerResult`, `IncomingMessage`.
2. `packages/messaging/src/topology.ts` (61 dòng) — vẽ sơ đồ exchange/queue từ `declareConsumerTopology`.
3. `packages/messaging/src/consumer.ts` (196 dòng) — theo dõi `process` (dòng 116-167). *Hỏi*: handler ném exception thì chuyện gì xảy ra? (dòng 131-136)
4. `packages/messaging/src/publisher.ts` — `ConfirmPublisher.publish`, **không bao giờ ném** (comment dòng 9-13).
5. `packages/messaging/src/client.ts` — tự phục hồi sau mất kết nối (comment dòng 23-28).
6. `services/wallet/src/interface/messaging/order-ready.handler.ts` (75 dòng) và `order-payments.topology.ts`.
7. `services/wallet/src/application/relay-outbox.ts` (105 dòng).
8. `docs/integration/dlq-runbook.vi.md` — đọc cả file; ghi lại 3 cách đưa message từ DLQ về hàng đợi làm việc.
9. Test sống: `packages/messaging/src/consumer.test.ts` (không cần Docker) và `services/wallet/src/interface/messaging/order-ready.handler.test.ts`.

## Thực hành
1. Chạy test messaging không cần Docker: `corepack pnpm vitest run packages/messaging services/wallet/src/interface/messaging` [ĐÃ CHẠY] 7 file, 46 test pass. (Các file `*.integration.test.ts` bị loại tự động.)
2. **Sửa code**: trong `order-ready.handler.ts` thêm một dòng `deps.log.info(...)` ngay trước `return { action: 'ack' }` ghi `retryCount: message.retryCount`. Chạy `order-ready.handler.test.ts`, `typecheck`, `lint`.
3. **Thêm một nhánh có kiểm chứng**: viết test trong `order-ready.handler.test.ts` cho trường hợp `payOrder.execute` ném `Error('db down')` và khẳng định handler **ném lại** (để consumer chuyển thành retry). Đọc test hiện có để mô phỏng đúng kiểu giả (mock) đang dùng.
4. [CHƯA CHẠY: cần Docker] Chạy stack local theo `docs/ops/local-stack.vi.md`, rồi `corepack pnpm local:seed -- --with-dlq` (README repo) để có một message hỏng trong DLQ; mở RabbitMQ management (`http://localhost:15674`, đăng nhập tài khoản admin trong `deploy/.env`) và xem queue `wallet.order-payments.dlq`, đọc header `x-dead-letter-reason`.
5. [CHƯA CHẠY] Chạy integration test messaging: `corepack pnpm test:integration packages/messaging`.

## Thử thách troubleshoot (nhóm messaging/outbox/DLQ)
**Tình huống A**: dashboard báo rule `billing-dlq-not-empty` (critical). Làm gì?
*Các bước từ runbook* (`dlq-runbook.vi.md`): (1) mở message trong RabbitMQ management ở chế độ requeue để không mất, đọc `x-dead-letter-reason`, `x-last-error`, `x-retry-count`; (2) **chỉ đưa lại khi nguyên nhân đã hết** (hạ tầng khỏe lại), lỗi vĩnh viễn thì sửa gốc trước; (3) kiểm tra wallet đang consume. Đưa lại an toàn vì `PayOrder` idempotent (Ngày 4).
**Tình huống B**: log wallet có `no queue is bound to receive the event; will retry` lặp lại.
*Đáp án*: kết quả `unroutable` (`relay-outbox.ts:75-78`): không có queue nào gắn với routing key của event trên `billing.events`. Kiểm tra binding ở RabbitMQ (script init `tools/rabbitmq-init.test.ts` mô tả; tác giả chưa đọc script init). Outbox không bỏ dòng: sẽ thử lại theo backoff.
**Tình huống C**: ecommerce nhận `OrderPaidV1` hai lần cho một order. Có phải lỗi?
*Đáp án*: không. Outbox giao ít nhất một lần và `REPLAYED` phát lại cùng `walletTransactionId` (`pay-order.ts:109-117`); ecommerce phải khử trùng theo `eventId` (`dlq-runbook.vi.md`, mục "Vì sao an toàn"). Chaos S4 chứng minh (`scenarios-sql-broker.chaos.test.ts:385`).

## Kiểm tra cuối ngày
1. Handler trả `reject` và `retry` trong trường hợp nào?
2. Message chạy hết 5 bậc retry sẽ đi đâu và mang lý do gì?
3. Vì sao ack chỉ sau khi transaction commit?
4. Vì sao `RelayOutbox` publish **ngoài** transaction DB?
5. `x-retry-count` bị gửi giá trị `-5` hoặc `abc`: hệ quả?
6. Vì sao có thể có `OrderPaidV1` trùng và ai chịu trách nhiệm xử lý?
7. Vì sao `forward` loại bỏ header `CC`/`BCC`?

### Đáp án
1. `reject`: message hỏng hoặc tenant lạ (`order-ready.handler.ts:27-33,45`); `retry`: lỗi hạ tầng do handler ném (`consumer.ts:131-136`).
2. `<queue>.dlq`, lý do `retries exhausted: <lý do>` (`consumer.ts:104-106`).
3. Nếu ack trước commit và process chết, message mất; ack sau commit thì tệ nhất là giao lại, và `PayOrder` idempotent (`pay-order.ts:83`). `docs/architecture/README.md` mục "Messaging".
4. Giữ transaction ngắn, không giữ khóa DB trong lúc chờ broker; đổi lại là giao ít nhất một lần (`relay-outbox.ts:22-25`).
5. Không phải số nguyên ≥ 0 thì coi là 0; vượt số bậc thì chặn ở số bậc (`consumer.ts:117-121`).
6. Outbox giao ít nhất một lần; bên nhận (ecommerce) khử trùng theo `eventId` (`relay-outbox.ts:22-25`).
7. RabbitMQ định tuyến theo chúng; tin từ upstream có thể chuyển message sang nơi khác (`consumer.ts:28-31`).

## Lỗi thường gặp khi chuyển từ MassTransit/RabbitMQ.Client sang amqplib
- Quên `confirm`/`mandatory` nên mất message không định tuyến (ở đây `ConfirmPublisher` lo).
- Dùng default exchange `amq.default` (cấm trong repo).
- Giả định "exactly once": hệ thống này là at-least-once + khử trùng.

## Câu hỏi còn mở (cho đội dev)
- ADR-0009 (`orders-payment-outbox-and-topology`) và `docs/integration/orders-handoff.vi.md`: hợp đồng chi tiết với ecommerce — tác giả chưa đọc.
- Cách ecommerce khử trùng `OrderPaidV1` nằm ngoài repo này; cần xác nhận với đội Orders.
