# Bàn giao cho team ecommerce: thanh toán order từ ví billing

Khi một order hoàn tất, ecommerce báo cho billing qua RabbitMQ; wallet trừ số dư ví của khách một lần duy nhất cho mỗi
`orderId` rồi báo kết quả. Sau khi nhận `OrderPaidV1`, order chuyển `Unpaid → Paid`.

```text
orders ── OrderReadyForPaymentV1 ──▶ orders.events ──▶ wallet (trừ ví, ghi sổ kép)
orders ◀── OrderPaidV1 / OrderPaymentFailedV1 ◀── billing.events ◀── wallet (qua outbox)
```

## Việc cần làm phía ecommerce

1. Thêm trạng thái `Unpaid`/`Paid` cho Order. Chỉ chuyển `Unpaid → Paid` khi nhận `OrderPaidV1`; bỏ qua nếu đã `Paid`.
2. Publish `OrderReadyForPaymentV1` qua outbox khi order hoàn tất. `amount` là **số nguyên minor unit** (VND: đồng, USD: cent)
   kèm `currency`; adapter đổi từ `total decimal` của `OrderPlacedV1`.
3. Consume `OrderPaidV1` và `OrderPaymentFailedV1` từ `billing.events`, khử trùng theo `eventId` (wallet giao ít nhất một
   lần). `OrderPaymentFailedV1` chỉ ghi lý do và giữ order ở `Unpaid`. **`Paid` là trạng thái cuối:** một
   `OrderPaymentFailedV1` đến sau khi order đã `Paid` **phải bị bỏ qua** (có thể xảy ra hợp lệ, ví dụ `CONFLICT` sau khi gửi
   lại với thông tin khác, hoặc một lần từ chối cũ đến muộn). Kết quả của cùng một `orderId` có thể đến **không theo thứ tự**
   và nhiều lần: hãy áp dụng theo trạng thái hiện tại của order, không theo thứ tự đến.
4. Cấu hình MassTransit gửi/nhận **JSON thuần** (không envelope MassTransit) tới vhost `billing` bằng user `ecommerce_orders`.
5. Đưa schema vào `shared/EventContracts` (có test bất biến sẵn của repo), viết và verify Pact, nối Pact Broker.

## Hợp đồng

JSON phẳng, camelCase; trường lạ phải được bỏ qua (tolerant reader). Schema JSON Schema 2020-12 nằm ở `packages/contracts`
của billing; lấy bản file bằng `corepack pnpm --filter @billing/contracts emit` (thư mục `packages/contracts/dist/schemas/`):
`OrderReadyForPayment.v1.schema.json`, `OrderPaid.v1.schema.json`, `OrderPaymentFailed.v1.schema.json`.

| Event | Phát → nhận | Routing key | Trường nghiệp vụ |
|---|---|---|---|
| `OrderReadyForPaymentV1` | orders → wallet | `order-ready-for-payment.v1` | `orderId` (UUID), `customerId`, `amount`, `currency` |
| `OrderPaidV1` | wallet → orders | `order-paid.v1` | `orderId`, `walletTransactionId`, `amount`, `currency`, `paidAtUtc` |
| `OrderPaymentFailedV1` | wallet → orders | `order-payment-failed.v1` | `orderId`, `reason` |

Trường chung bắt buộc của cả ba: `eventId` (UUID), `occurredAtUtc` (RFC 3339 date-time; chấp nhận phần giây thập phân như
`2026-10-10T10:00:00.1234567Z` và offset như `+07:00`), `tenantId`, `correlationId`.
`reason` ∈ `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`.

Giới hạn giá trị (schema từ chối nếu vượt, vì wallet không lưu được): `tenantId` và `customerId` 1..64 ký tự,
`correlationId` 1..100 ký tự, `amount` là số nguyên từ 1 đến 9007199254740991 (`Number.MAX_SAFE_INTEGER`).

Thuộc tính AMQP wallet đặt khi phát: `contentType = application/json`, `messageId = eventId`, `type =` tên event,
`deliveryMode = 2` (persistent), header `x-correlation-id`.

<!-- example: OrderReadyForPaymentV1 -->
```json
{
  "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02",
  "occurredAtUtc": "2026-10-10T10:00:00Z",
  "tenantId": "acme",
  "correlationId": "7c1d9b0e-1a5f-4d58-9f0e-3a2b1c0d9e8f",
  "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
  "customerId": "cust-1",
  "amount": 150000,
  "currency": "VND"
}
```

<!-- example: OrderPaidV1 -->
```json
{
  "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c03",
  "occurredAtUtc": "2026-10-10T10:00:01Z",
  "tenantId": "acme",
  "correlationId": "7c1d9b0e-1a5f-4d58-9f0e-3a2b1c0d9e8f",
  "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
  "walletTransactionId": "tx_5b1d0c1c8a3f4e6f9a7b2c4d6e8f0a1b",
  "amount": 150000,
  "currency": "VND",
  "paidAtUtc": "2026-10-10T10:00:01Z"
}
```

<!-- example: OrderPaymentFailedV1 -->
```json
{
  "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c04",
  "occurredAtUtc": "2026-10-10T10:00:01Z",
  "tenantId": "acme",
  "correlationId": "7c1d9b0e-1a5f-4d58-9f0e-3a2b1c0d9e8f",
  "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
  "reason": "INSUFFICIENT_FUNDS"
}
```

## Broker

- vhost `billing`; hai exchange topic bền `orders.events` (ecommerce ghi) và `billing.events` (wallet ghi) do script
  `deploy/scripts/init-rabbitmq.sh` khai báo.
- User `ecommerce_orders`: ghi `orders.events`; khai báo queue có tiền tố `ecommerce.` (ví dụ `ecommerce.order-results`) và
  gắn vào `billing.events` với hai key `order-paid.v1`, `order-payment-failed.v1`; đọc queue của mình.
- Wallet publish có `mandatory`: nếu **chưa có queue nào** gắn vào `billing.events` thì kết quả không bị mất, wallet giữ lại
  và thử lại (1 s, 5 s, 30 s, 120 s, rồi 600 s mỗi lần) cho đến khi ecommerce khai báo queue. Hãy khai báo queue trước khi bật luồng.

## Quy tắc nghiệp vụ cần biết

- **Idempotency theo `orderId`:** gửi lại cùng `orderId` với cùng khách, số tiền, đồng tiền thì wallet **không trừ thêm** và phát
  lại `OrderPaidV1` với đúng `walletTransactionId` cũ (`eventId` mới). Cùng `orderId` nhưng khác khách/số tiền/đồng tiền →
  `OrderPaymentFailedV1(CONFLICT)`, không trừ tiền, wallet ghi cảnh báo.
- **Thiếu tiền** → `INSUFFICIENT_FUNDS`; wallet **không ghi nhớ** lần từ chối, nên sau khi khách nạp thêm tiền ecommerce có thể
  publish lại `OrderReadyForPaymentV1` (cùng `orderId`, `eventId` mới) để thử lại.
- Message sai schema hoặc `tenantId` wallet không phục vụ sẽ vào hàng đợi chết của wallet (`wallet.order-payments.dlq`) và không
  có phản hồi; hãy bảo đảm `tenantId` khớp danh sách tenant cấu hình ở wallet (`WALLET_TENANTS`).
- **Hết lượt retry khi hạ tầng sự cố:** message mà wallet xử lý mãi không được vì sự cố hạ tầng (database/broker; các bậc mặc định
  5, 30, 120, 600, 1800 s, tức khoảng 43 phút) cũng vào `wallet.order-payments.dlq` **mà không có phản hồi**. Nếu sau một khoảng
  timeout ecommerce chưa nhận kết quả cho một order, hãy publish lại cùng `orderId` với `eventId` mới: an toàn và được
  khuyến nghị (xử lý idempotent). Quy trình vận hành xử lý DLQ: `docs/integration/dlq-runbook.vi.md`.
- **`Paid` là cuối, kết quả có thể đến lộn xộn:** xem mục 3 ở trên; `OrderPaymentFailedV1` cho order đã `Paid` phải bị bỏ qua.
- Wallet không đảm bảo thứ tự giữa các order, cũng không giữa các kết quả của cùng một order.

## Gợi ý MassTransit (cần xác nhận phía ecommerce)

Dùng serializer/deserializer JSON thuần (`UseRawJsonSerializer`/`UseRawJsonDeserializer`), tắt tự tạo topology cho các
exchange này và trỏ endpoint tới `orders.events`/`ecommerce.*` đã khai báo sẵn. MassTransit đang ghim 8.x (xem file
`Directory.Packages.props` trong repo ecommerce); cách cấu hình cụ thể là việc của team ecommerce.

## Pact và Pact Broker

Hai chiều: `wallet` là consumer của `OrderReadyForPaymentV1` (provider `orders`), `orders` là consumer của `OrderPaidV1` và
`OrderPaymentFailedV1` (provider `wallet`). Pact message, spec 3.0.0 (PactNet 5 đọc được). Pact mẫu phía `orders` để tham khảo:
`services/wallet/pact-fixtures/orders-wallet.json`. Cách chạy broker và publish/verify: `docs/integration/pact-broker.vi.md`.

## Câu hỏi mở

- Danh sách tenant của gateway ecommerce phải khớp `WALLET_TENANTS` của wallet.
- Instance RabbitMQ dùng chung và cách truy cập từ máy phát triển (ADR-0004).
