# E4 — Thanh toán order qua RabbitMQ

## Mục tiêu

Kiểm tra trọn vẹn một order được thanh toán bằng ví: QA đóng vai ecommerce, publish `OrderReadyForPaymentV1` vào RabbitMQ; wallet trừ ví đúng một lần cho mỗi `orderId` rồi trả `OrderPaidV1` hoặc `OrderPaymentFailedV1`. Postman gọi RabbitMQ management API để tạo queue nhận kết quả, publish order và đọc kết quả.

- Service tham gia: wallet, RabbitMQ (qua management API).
- Có phần tiêm lỗi hoặc tạo lỗi: không.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe, gồm RabbitMQ.
- Environment có `e2e_rabbitmq_user` và `e2e_rabbitmq_password` (lấy từ `BILLING_RABBITMQ_ADMIN_USER` / `BILLING_RABBITMQ_ADMIN_PASSWORD` trong `deploy/.env`) và `e2e_rabbitmq_url` trỏ đúng cổng management (mặc định `http://localhost:15674`).

## Cách chạy

| Folder | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| E4 Thanh toán order qua RabbitMQ | 20 | 20 request (wallet 9, RabbitMQ management 11) | `4cca8188-dbdb-5ada-acc8-530e0fde919e` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải folder `E4 Thanh toán order qua RabbitMQ` > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 120 giây cho phần dài nhất.

**Chạy bằng Postman CLI:**

```bash
postman collection run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  -i 4cca8188-dbdb-5ada-acc8-530e0fde919e
```

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E4-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E4-02 RabbitMQ management khả dụng` | `200`; `name` bằng `e2e_rabbitmq_user`. |
| 3 | Tay hoặc Runner | `E4-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Tay hoặc Runner | `E4-04 Yêu cầu nạp 150000` | `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`. |
| 5 | Poll (tay: gửi lại; Runner: tự lặp) | `E4-05 Poll topup đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 6 | Tay hoặc Runner | `E4-06 Số dư = 150000 trước khi trả order` | `200`; `balance` `150000`. |
| 7 | Tay hoặc Runner | `E4-07 Tạo queue nhận kết quả (idempotent)` | `201` nếu mới tạo, `204` nếu đã có. |
| 8 | Tay hoặc Runner | `E4-08 Gắn queue vào billing.events (order-paid.v1)` | `201` hoặc `204`. |
| 9 | Tay hoặc Runner | `E4-09 Gắn queue vào billing.events (order-payment-failed.v1)` | `201` hoặc `204`. |
| 10 | Tay hoặc Runner | `E4-10 Dọn message cũ trong queue kết quả` | `204`. |
| 11 | Tay hoặc Runner | `E4-11 Publish order 1 (100000)` | `200`, `{"routed": true}`.  |
| 12 | Poll (tay: gửi lại; Runner: tự lặp) | `E4-12 Đọc OrderPaid của order 1` | `200`; có đúng 1 message `order-paid.v1` với `orderId`, `amount` `100000`, `currency` `VND`, `tenantId`, `walletTransactionId`, `paidAtUtc`. |
| 13 | Tay hoặc Runner | `E4-13 Số dư = 50000 sau khi trả order` | `200`; `balance` `50000`. |
| 14 | Tay hoặc Runner | `E4-14 Sổ cái có đúng 1 entry order` | `200`; tổng `amount` = `50000`; đúng 1 entry `order:<orderId>`. |
| 15 | Tay hoặc Runner | `E4-15 Publish lại cùng orderId với eventId mới` | `200`, `{"routed": true}`.  |
| 16 | Poll (tay: gửi lại; Runner: tự lặp) | `E4-16 Đọc OrderPaid phát lại` | `200`; có đúng 2 message `order-paid.v1` của order 1, cùng `walletTransactionId`, `eventId` khác nhau. |
| 17 | Tay hoặc Runner | `E4-17 Số dư vẫn 50000 sau khi phát lại` | `200`; `balance` `50000`. |
| 18 | Tay hoặc Runner | `E4-18 Publish order 2 vượt số dư (100000)` | `200`, `{"routed": true}`.  |
| 19 | Poll (tay: gửi lại; Runner: tự lặp) | `E4-19 Đọc OrderPaymentFailed của order 2` | `200`; 1 message `order-payment-failed.v1` với `reason` `INSUFFICIENT_FUNDS`. |
| 20 | Tay hoặc Runner | `E4-20 Số dư vẫn 50000 sau order bị từ chối` | `200`; `balance` `50000`. |

## Chi tiết từng bước

### Bước 1 — Wallet health và khởi tạo lượt chạy

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/health`
- Làm gì: Kiểm tra wallet khỏe và tạo mã lượt chạy mới (customer id mới, ngày UTC hôm nay). Luôn chạy bước này đầu tiên của luồng.
- Kết quả mong đợi: `200`, `{"status":"ok","service":"wallet"}`.
- Biến: Ghi: `e2e_run`, `e2e_cust`, `e2e_today`, `e2e_order_id`.

### Bước 2 — RabbitMQ management khả dụng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{e2e_rabbitmq_url}}/api/whoami`
- Làm gì: Kiểm tra RabbitMQ management API truy cập được với tài khoản quản trị lấy từ `deploy/.env`.
- Kết quả mong đợi: `200`; `name` bằng `e2e_rabbitmq_user`.
- Biến: Đọc: `e2e_rabbitmq_url`, `e2e_rabbitmq_user`, `e2e_rabbitmq_password`.

### Bước 3 — Tạo ví VND

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/wallets`
- Làm gì: Tạo ví VND cho customer của lượt chạy.
- Kết quả mong đợi: `201`; `currency` `VND`, `balance` `0`.
- Biến: Đọc: `e2e_cust`.

### Bước 4 — Yêu cầu nạp 150000

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/topups`
- Làm gì: Gửi yêu cầu nạp 150000 VND với `Idempotency-Key` mới. Wallet luôn trả `202` rồi mới xử lý bất đồng bộ.
- Kết quả mong đợi: `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`.
- Biến: Ghi: `e2e_topup_key`, `e2e_topup_id`. Đọc: `e2e_cust`.

### Bước 5 — Poll topup đến SUCCEEDED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id}}`
- Làm gì: Chờ topup có trạng thái cuối. Chạy tay: gửi lại request mỗi 1-2 giây cho đến khi `status` là `SUCCEEDED`. Runner: tự lặp tối đa `e2e_poll_max_attempts` lần, mỗi lần cách `poll_interval_ms`.
- Kết quả mong đợi: `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`.
- Biến: Đọc: `e2e_topup_id`, `e2e_poll_max_attempts`, `poll_interval_ms`.

### Bước 6 — Số dư = 150000 trước khi trả order

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi nạp.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 7 — Tạo queue nhận kết quả (idempotent)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `PUT {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}`
- Làm gì: Tạo queue bền `ecommerce.e2e-results` ở vhost `billing`. Wallet publish kết quả kiểu bắt buộc định tuyến, nên cần có queue gắn vào `billing.events`; queue này đóng vai consumer của ecommerce. Queue được giữ lại sau khi chạy xong.
- Kết quả mong đợi: `201` nếu mới tạo, `204` nếu đã có.
- Biến: Đọc: `e2e_rabbitmq_url`, `e2e_rabbitmq_vhost`, `e2e_results_queue`.

### Bước 8 — Gắn queue vào billing.events (order-paid.v1)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/bindings/{{e2e_rabbitmq_vhost}}/e/billing.events/q/{{e2e_results_queue}}`
- Làm gì: Gắn queue kết quả vào exchange `billing.events` với routing key `order-paid.v1`.
- Kết quả mong đợi: `201` hoặc `204`.
- Biến: Đọc: `e2e_rabbitmq_url`, `e2e_rabbitmq_vhost`, `e2e_results_queue`.

### Bước 9 — Gắn queue vào billing.events (order-payment-failed.v1)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/bindings/{{e2e_rabbitmq_vhost}}/e/billing.events/q/{{e2e_results_queue}}`
- Làm gì: Gắn queue kết quả vào exchange `billing.events` với routing key `order-payment-failed.v1`.
- Kết quả mong đợi: `201` hoặc `204`.
- Biến: Đọc: `e2e_rabbitmq_url`, `e2e_rabbitmq_vhost`, `e2e_results_queue`.

### Bước 10 — Dọn message cũ trong queue kết quả

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `DELETE {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/contents`
- Làm gì: Xóa mọi message đang nằm trong queue kết quả để các bước đọc sau chỉ thấy message của lượt chạy này.
- Kết quả mong đợi: `204`.
- Biến: Đọc: `e2e_rabbitmq_url`, `e2e_rabbitmq_vhost`, `e2e_results_queue`.

### Bước 11 — Publish order 1 (100000)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/exchanges/{{e2e_rabbitmq_vhost}}/orders.events/publish`
- Làm gì: Publish `OrderReadyForPaymentV1` cho order 1, số tiền 100000 VND, `eventId` mới.
- Kết quả mong đợi: `200`, `{"routed": true}`. 
- Biến: Ghi: `e2e_event_id`, `e2e_publish_body`. Đọc: `e2e_order_id`, `e2e_cust`, `tenant_id`, `e2e_run`.
- Lưu ý:
  - Bước này đóng vai ecommerce: publish `OrderReadyForPaymentV1` vào exchange `orders.events` với routing key `order-ready-for-payment.v1`.

### Bước 12 — Đọc OrderPaid của order 1

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `POST {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/get`
- Làm gì: Chờ message `order-paid.v1` của order 1 trong queue kết quả và kiểm nội dung.
- Kết quả mong đợi: `200`; có đúng 1 message `order-paid.v1` với `orderId`, `amount` `100000`, `currency` `VND`, `tenantId`, `walletTransactionId`, `paidAtUtc`.
- Biến: Ghi: `e2e_tx_id`, `e2e_paid_event_id`. Đọc: `e2e_order_id`.
- Lưu ý:
  - Đọc message không làm mất message (`ack_requeue_true`). Chạy tay: gửi lại cho đến khi message xuất hiện (thường sau vài giây). Runner: tự lặp.

### Bước 13 — Số dư = 50000 sau khi trả order

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: ví bị trừ 100000.
- Kết quả mong đợi: `200`; `balance` `50000`.
- Biến: Đọc: `e2e_cust`.

### Bước 14 — Sổ cái có đúng 1 entry order

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: đúng một entry có `businessKey` `order:<orderId>` và tổng entries bằng số dư.
- Kết quả mong đợi: `200`; tổng `amount` = `50000`; đúng 1 entry `order:<orderId>`.
- Biến: Đọc: `e2e_cust`.

### Bước 15 — Publish lại cùng orderId với eventId mới

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/exchanges/{{e2e_rabbitmq_vhost}}/orders.events/publish`
- Làm gì: Publish lại cùng `orderId`, cùng khách, cùng số tiền, nhưng `eventId` mới.
- Kết quả mong đợi: `200`, `{"routed": true}`. 
- Biến: Ghi: `e2e_event_id`, `e2e_publish_body`. Đọc: `e2e_order_id`, `e2e_cust`, `tenant_id`, `e2e_run`.
- Lưu ý:
  - Bước này đóng vai ecommerce: publish `OrderReadyForPaymentV1` vào exchange `orders.events` với routing key `order-ready-for-payment.v1`.

### Bước 16 — Đọc OrderPaid phát lại

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `POST {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/get`
- Làm gì: Chờ message `order-paid.v1` thứ hai của order 1.
- Kết quả mong đợi: `200`; có đúng 2 message `order-paid.v1` của order 1, cùng `walletTransactionId`, `eventId` khác nhau.
- Biến: Đọc: `e2e_order_id`.
- Lưu ý:
  - Đọc message không làm mất message (`ack_requeue_true`). Chạy tay: gửi lại cho đến khi message xuất hiện (thường sau vài giây). Runner: tự lặp.

### Bước 17 — Số dư vẫn 50000 sau khi phát lại

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: ví không bị trừ lần hai.
- Kết quả mong đợi: `200`; `balance` `50000`.
- Biến: Đọc: `e2e_cust`.

### Bước 18 — Publish order 2 vượt số dư (100000)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/exchanges/{{e2e_rabbitmq_vhost}}/orders.events/publish`
- Làm gì: Publish order mới (`orderId` mới) 100000 VND trong khi số dư chỉ còn 50000.
- Kết quả mong đợi: `200`, `{"routed": true}`. 
- Biến: Ghi: `e2e_event_id`, `e2e_publish_body`, `e2e_order2_id`. Đọc: `e2e_order2_id`, `e2e_cust`, `tenant_id`, `e2e_run`.
- Lưu ý:
  - Bước này đóng vai ecommerce: publish `OrderReadyForPaymentV1` vào exchange `orders.events` với routing key `order-ready-for-payment.v1`.

### Bước 19 — Đọc OrderPaymentFailed của order 2

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `POST {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/get`
- Làm gì: Chờ message `order-payment-failed.v1` của order 2.
- Kết quả mong đợi: `200`; 1 message `order-payment-failed.v1` với `reason` `INSUFFICIENT_FUNDS`.
- Biến: Đọc: `e2e_order2_id`.
- Lưu ý:
  - Đọc message không làm mất message (`ack_requeue_true`). Chạy tay: gửi lại cho đến khi message xuất hiện (thường sau vài giây). Runner: tự lặp.

### Bước 20 — Số dư vẫn 50000 sau order bị từ chối

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: order bị từ chối không làm đổi số dư.
- Kết quả mong đợi: `200`; `balance` `50000`.
- Biến: Đọc: `e2e_cust`.

## Kiểm tra cuối luồng

- Order 1 trả đúng một lần: số dư `50000`, đúng một entry `order:<orderId>`.
- Phát lại cùng `orderId` không trừ thêm tiền.
- Order 2 bị từ chối với `INSUFFICIENT_FUNDS`, số dư không đổi.
