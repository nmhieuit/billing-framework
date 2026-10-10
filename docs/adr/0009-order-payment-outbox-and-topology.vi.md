# ADR-0009: Trả order qua RabbitMQ — outbox theo tenant, publish có `mandatory`, topology không dùng default exchange

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Wallet phải trừ ví đúng một lần cho mỗi order dù message bị giao lại hoặc nhiều consumer chạy song song, và báo kết quả cho
ecommerce mà không bao giờ mất (kể cả khi broker hoặc ecommerce tạm thời không sẵn sàng).

## Quyết định

- `PayOrder` ghi inbox, sổ cái (`ORDER_PAYMENT`, `business_key = order:<orderId>`), `order_payments` và dòng outbox trong
  **một** transaction của schema tenant. Kết quả từ chối nghiệp vụ cũng commit (inbox + outbox) và được ack.
- Relay chiếm một dòng outbox bằng lease, publish **ngoài** transaction, rồi đánh dấu đã gửi: giao ít nhất một lần, bên
  nhận khử trùng theo `eventId`. Publish dùng confirm và cờ `mandatory`; `NO_ROUTE` là thất bại và dòng được thử lại
  (không mất kết quả khi ecommerce chưa khai báo queue).
- Consumer retry theo bậc TTL qua exchange `wallet.retry`/`wallet.work` rồi DLQ; không dùng default exchange vì quyền ghi
  `amq.default` cho phép ghi vào mọi queue của vhost. Quyền của từng user giới hạn theo tiền tố queue và theo exchange.
- Kết nối dùng `recovery` của `amqplib`; sau mỗi lần kết nối lại, channel và consumer được dựng lại.

## Phương án đã loại

- Publish trực tiếp trong use case: mất event nếu publish lỗi sau commit, hoặc mất tiền nếu commit lỗi sau publish.
- Outbox dùng chung một bảng ngoài schema tenant: phá cô lập tenant (ADR-0006) và cần quan hệ chéo schema.
- Retry bằng default exchange / `sendToQueue`: cần quyền ghi `amq.default` (đã kiểm chứng bằng thử nghiệm thật).

## Hệ quả

Chết giữa commit và ack → message giao lại và bị inbox chặn (không trừ lại, không phát lại event). Chết giữa publish và
`markSent` → event được gửi lại sau lease; ecommerce phải khử trùng theo `eventId`. Thứ tự giữa các order không được đảm bảo.
Wallet xử lý từng tenant tuần tự trong mỗi lượt worker (tối đa `OUTBOX_BATCH` dòng mỗi tenant), nên một tenant tồn đọng có
thể làm các tenant khác chậm hơn khi broker lỗi.
