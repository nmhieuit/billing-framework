# Runbook: hàng đợi chết `wallet.order-payments.dlq`

Message vào `wallet.order-payments.dlq` khi wallet **không xử lý được và không trả lời**:

- sai schema, hoặc `tenantId` wallet không phục vụ (lỗi vĩnh viễn, xem header `x-dead-letter-reason`);
- hết các bậc retry (mặc định `ORDER_RETRY_DELAYS=5,30,120,600,1800` giây, khoảng 43 phút) vì sự cố hạ tầng kéo dài
  (database, broker, payment). Lý do dạng `retries exhausted: ...`.

Ecommerce **không** nhận `OrderPaymentFailedV1` cho các message này. Chúng chỉ được xử lý lại khi có người đưa chúng về
hàng đợi làm việc.

## Trước khi đưa về hàng đợi

1. Xem lý do: mở message trong RabbitMQ management (Queues → `wallet.order-payments.dlq` → Get messages, chế độ
   _Nack message requeue true_ để không mất) và đọc header `x-dead-letter-reason`, `x-last-error`, `x-retry-count`.
2. **Chỉ đưa lại khi nguyên nhân đã hết.** Hạ tầng đã khỏe lại (database, payment, broker) thì đưa lại là đúng. Lỗi
   vĩnh viễn (sai schema, tenant không được phục vụ) sẽ quay lại DLQ sau các bậc retry: sửa gốc (ecommerce publish đúng,
   hoặc thêm tenant vào `WALLET_TENANTS`) rồi mới đưa lại, hoặc để ecommerce publish message mới.
3. Kiểm tra wallet đang chạy và đang consume (`wallet.order-payments` có consumer).

## Đưa message về hàng đợi làm việc

Đích: exchange `wallet.work`, routing key `order-payments` (queue chính `wallet.order-payments` gắn vào đó).

Cách 1, RabbitMQ management: Queues → `wallet.order-payments.dlq` → **Move messages** → đích
`wallet.work` + routing key `order-payments` (hoặc đích là queue `wallet.order-payments`). Cần tài khoản có quyền đọc DLQ và
ghi `wallet.work`; user `billing_wallet` có đủ quyền.

Cách 2, shovel tạm thời (đóng lại sau khi xong): nguồn là queue `wallet.order-payments.dlq`, đích là exchange `wallet.work`
với key `order-payments`, `src-delete-after = queue-length`.

Cách 3, script `amqplib` (Node):

```js
import amqp from 'amqplib';

const conn = await amqp.connect({ hostname, username: 'billing_wallet', password, vhost: 'billing' });
const ch = await conn.createConfirmChannel();
for (;;) {
  const msg = await ch.get('wallet.order-payments.dlq', { noAck: false });
  if (!msg) break;
  const headers = { ...msg.properties.headers };
  for (const name of Object.keys(headers)) {
    // bỏ header do broker/consumer thêm; đặt lại bộ đếm retry để message có đủ các bậc
    if (name.startsWith('x-') || name === 'CC' || name === 'BCC') delete headers[name];
  }
  await new Promise((resolve, reject) =>
    ch.publish('wallet.work', 'order-payments', msg.content, { ...msg.properties, headers, persistent: true },
      (err) => (err ? reject(err) : resolve())),
  );
  ch.ack(msg); // chỉ ack sau khi publish được confirm: không mất message nếu script chết giữa chừng
}
await conn.close();
```

Giữ nguyên `messageId`, `type` và header `x-correlation-id` (script trên giữ `properties`; nếu dùng cách khác hãy giữ).

## Vì sao an toàn

- `PayOrder` idempotent theo `eventId` (inbox) và theo `orderId` (`business_key = order:<orderId>`): xử lý lại một message
  không trừ thêm tiền, chỉ phát lại `OrderPaidV1` với đúng `walletTransactionId` cũ.
- Message giao nhiều lần, hoặc cùng `orderId` với `eventId` mới (ecommerce publish lại sau timeout), đều an toàn như nhau.
- Ecommerce khử trùng kết quả theo `eventId` và coi `Paid` là trạng thái cuối (xem `orders-handoff.vi.md`).

## Giám sát

- Cảnh báo khi **độ sâu `wallet.order-payments.dlq` > 0** (metric `rabbitmq_queue_messages_ready{queue="wallet.order-payments.dlq"}`
  nếu dùng plugin Prometheus, hoặc management API `GET /api/queues/billing/wallet.order-payments.dlq`).
- Cảnh báo thêm khi `wallet.order-payments` không có consumer, và khi tuổi message cũ nhất ở các queue `...retry.<giây>` lớn
  hơn bậc tương ứng (retry bị kẹt).
- Sau mỗi sự cố hạ tầng, kiểm tra DLQ ngay khi hạ tầng khỏe lại, trước khi ecommerce phải tự publish lại.
