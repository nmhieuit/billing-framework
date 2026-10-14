# E5 — Vận hành trên ví đã có tiền

## Mục tiêu

Kiểm tra các công cụ vận hành (ops) phối hợp với luồng order: đóng băng ví làm order bị từ chối, mở băng thì order thành công, phát lại `OrderPaidV1` (replay-paid), điều chỉnh và đảo giao dịch, và nhật ký thao tác ghi đủ.

- Service tham gia: wallet, RabbitMQ (qua management API).
- Có phần tiêm lỗi hoặc tạo lỗi: không.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe, gồm RabbitMQ.
- Environment có các biến `e2e_rabbitmq_*` (xem [`e4-thanh-toan-order-rabbitmq.md`](e4-thanh-toan-order-rabbitmq.md)), `actor_id`, `actor_role`.

## Cách chạy

| Folder | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| E5 Vận hành trên ví đã có tiền | 26 | 26 request (wallet 16, RabbitMQ management 10) | `fb5257d2-928c-5428-a494-9d08d22f6b2d` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải folder `E5 Vận hành trên ví đã có tiền` > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 120 giây cho phần dài nhất.

**Chạy bằng Postman CLI:**

```bash
postman collection run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  -i fb5257d2-928c-5428-a494-9d08d22f6b2d
```

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E5-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E5-02 RabbitMQ management khả dụng` | `200`; `name` bằng `e2e_rabbitmq_user`. |
| 3 | Tay hoặc Runner | `E5-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Tay hoặc Runner | `E5-04 Yêu cầu nạp 150000` | `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`. |
| 5 | Poll (tay: gửi lại; Runner: tự lặp) | `E5-05 Poll topup đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 6 | Tay hoặc Runner | `E5-06 Số dư = 150000 trước khi trả order` | `200`; `balance` `150000`. |
| 7 | Tay hoặc Runner | `E5-07 Tạo queue nhận kết quả (idempotent)` | `201` nếu mới tạo, `204` nếu đã có. |
| 8 | Tay hoặc Runner | `E5-08 Gắn queue vào billing.events (order-paid.v1)` | `201` hoặc `204`. |
| 9 | Tay hoặc Runner | `E5-09 Gắn queue vào billing.events (order-payment-failed.v1)` | `201` hoặc `204`. |
| 10 | Tay hoặc Runner | `E5-10 Dọn message cũ trong queue kết quả` | `204`. |
| 11 | Tay hoặc Runner | `E5-11 Freeze ví` | `200`; `frozen` `true`, `changed` `true`, có `actionId`. |
| 12 | Tay hoặc Runner | `E5-12 Publish order khi ví đóng băng` | `200`, `{"routed": true}`.  |
| 13 | Poll (tay: gửi lại; Runner: tự lặp) | `E5-13 Đọc OrderPaymentFailed WALLET_FROZEN` | `200`; 1 message `order-payment-failed.v1` với `reason` `WALLET_FROZEN`. |
| 14 | Tay hoặc Runner | `E5-14 Số dư vẫn 150000 khi ví đóng băng` | `200`; `balance` `150000`. |
| 15 | Tay hoặc Runner | `E5-15 Unfreeze ví` | `200`; `frozen` `false`, `changed` `true`, `frozenAt` `null`. |
| 16 | Tay hoặc Runner | `E5-16 Publish lại cùng orderId sau khi mở băng` | `200`, `{"routed": true}`.  |
| 17 | Poll (tay: gửi lại; Runner: tự lặp) | `E5-17 Đọc OrderPaid sau khi mở băng` | `200`; 1 message `order-paid.v1` đúng nội dung. |
| 18 | Tay hoặc Runner | `E5-18 Số dư = 50000 sau khi trả order` | `200`; `balance` `50000`. |
| 19 | Tay hoặc Runner | `E5-19 Replay-paid của order` | `202`; `eventId` bằng `eventId` của message `OrderPaid` gốc; có `actionId`. |
| 20 | Poll (tay: gửi lại; Runner: tự lặp) | `E5-20 Đọc OrderPaid được phát lại` | `200`; có 2 message `order-paid.v1` cùng `eventId` gốc; bản phát lại có `correlationId` bắt đầu bằng `ops-replay:`. |
| 21 | Tay hoặc Runner | `E5-21 Replay không thêm entry` | `200`; tổng `amount` = `50000`; đúng 1 entry `order:<orderId>`. |
| 22 | Tay hoặc Runner | `E5-22 Adjust DEBIT 10000` | `201`; có `transactionId` và `actionId`. |
| 23 | Tay hoặc Runner | `E5-23 Số dư = 40000 sau adjust` | `200`; `balance` `40000`. |
| 24 | Tay hoặc Runner | `E5-24 Đảo giao dịch adjust` | `201`; `reversesTransactionId` bằng giao dịch adjust. |
| 25 | Tay hoặc Runner | `E5-25 Số dư về 50000 sau khi đảo` | `200`; `balance` `50000`. |
| 26 | Tay hoặc Runner | `E5-26 Nhật ký ops có đủ 5 thao tác` | `200`; có đủ 5 `actionId` của luồng với đúng loại `FREEZE`, `UNFREEZE`, `REPLAY_PAID`, `ADJUST`, `REVERSE`. |

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

### Bước 11 — Freeze ví

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/ops/wallets/{{e2e_cust}}/freeze`
- Làm gì: Đóng băng ví của khách.
- Kết quả mong đợi: `200`; `frozen` `true`, `changed` `true`, có `actionId`.
- Biến: Ghi: `e2e_freeze_key`, `e2e_frz_action`. Đọc: `e2e_cust`.

### Bước 12 — Publish order khi ví đóng băng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/exchanges/{{e2e_rabbitmq_vhost}}/orders.events/publish`
- Làm gì: Publish order 100000 VND khi ví đang đóng băng.
- Kết quả mong đợi: `200`, `{"routed": true}`. 
- Biến: Ghi: `e2e_event_id`, `e2e_publish_body`. Đọc: `e2e_order_id`, `e2e_cust`, `tenant_id`, `e2e_run`.
- Lưu ý:
  - Bước này đóng vai ecommerce: publish `OrderReadyForPaymentV1` vào exchange `orders.events` với routing key `order-ready-for-payment.v1`.

### Bước 13 — Đọc OrderPaymentFailed WALLET_FROZEN

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `POST {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/get`
- Làm gì: Chờ message `order-payment-failed.v1` của order.
- Kết quả mong đợi: `200`; 1 message `order-payment-failed.v1` với `reason` `WALLET_FROZEN`.
- Biến: Đọc: `e2e_order_id`.
- Lưu ý:
  - Đọc message không làm mất message (`ack_requeue_true`). Chạy tay: gửi lại cho đến khi message xuất hiện (thường sau vài giây). Runner: tự lặp.

### Bước 14 — Số dư vẫn 150000 khi ví đóng băng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: order bị từ chối nên không trừ tiền.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 15 — Unfreeze ví

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/ops/wallets/{{e2e_cust}}/unfreeze`
- Làm gì: Mở băng ví.
- Kết quả mong đợi: `200`; `frozen` `false`, `changed` `true`, `frozenAt` `null`.
- Biến: Ghi: `e2e_unfreeze_key`, `e2e_unfrz_action`. Đọc: `e2e_cust`.

### Bước 16 — Publish lại cùng orderId sau khi mở băng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{e2e_rabbitmq_url}}/api/exchanges/{{e2e_rabbitmq_vhost}}/orders.events/publish`
- Làm gì: Publish lại **cùng `orderId`** với `eventId` mới sau khi ví đã được mở băng.
- Kết quả mong đợi: `200`, `{"routed": true}`. 
- Biến: Ghi: `e2e_event_id`, `e2e_publish_body`. Đọc: `e2e_order_id`, `e2e_cust`, `tenant_id`, `e2e_run`.
- Lưu ý:
  - Bước này đóng vai ecommerce: publish `OrderReadyForPaymentV1` vào exchange `orders.events` với routing key `order-ready-for-payment.v1`.

### Bước 17 — Đọc OrderPaid sau khi mở băng

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `POST {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/get`
- Làm gì: Chờ message `order-paid.v1` của order.
- Kết quả mong đợi: `200`; 1 message `order-paid.v1` đúng nội dung.
- Biến: Ghi: `e2e_tx_id`, `e2e_paid_event_id`. Đọc: `e2e_order_id`.
- Lưu ý:
  - Đọc message không làm mất message (`ack_requeue_true`). Chạy tay: gửi lại cho đến khi message xuất hiện (thường sau vài giây). Runner: tự lặp.

### Bước 18 — Số dư = 50000 sau khi trả order

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: ví bị trừ 100000.
- Kết quả mong đợi: `200`; `balance` `50000`.
- Biến: Đọc: `e2e_cust`.

### Bước 19 — Replay-paid của order

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/ops/orders/{{e2e_order_id}}/replay-paid`
- Làm gì: Phát lại sự kiện `OrderPaidV1` của order đã trả. Ví không bị trừ thêm.
- Kết quả mong đợi: `202`; `eventId` bằng `eventId` của message `OrderPaid` gốc; có `actionId`.
- Biến: Ghi: `e2e_replay_key`, `e2e_replay_action`. Đọc: `e2e_order_id`, `e2e_paid_event_id`.

### Bước 20 — Đọc OrderPaid được phát lại

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `POST {{e2e_rabbitmq_url}}/api/queues/{{e2e_rabbitmq_vhost}}/{{e2e_results_queue}}/get`
- Làm gì: Chờ message `order-paid.v1` thứ hai của order (bản phát lại).
- Kết quả mong đợi: `200`; có 2 message `order-paid.v1` cùng `eventId` gốc; bản phát lại có `correlationId` bắt đầu bằng `ops-replay:`.
- Biến: Đọc: `e2e_order_id`, `e2e_paid_event_id`.
- Lưu ý:
  - Đọc message không làm mất message (`ack_requeue_true`). Chạy tay: gửi lại cho đến khi message xuất hiện (thường sau vài giây). Runner: tự lặp.

### Bước 21 — Replay không thêm entry

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: vẫn đúng một entry `order:<orderId>`, tổng entries bằng số dư.
- Kết quả mong đợi: `200`; tổng `amount` = `50000`; đúng 1 entry `order:<orderId>`.
- Biến: Đọc: `e2e_cust`.

### Bước 22 — Adjust DEBIT 10000

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/ops/wallets/{{e2e_cust}}/adjustments`
- Làm gì: Điều chỉnh trừ 10000 VND khỏi ví.
- Kết quả mong đợi: `201`; có `transactionId` và `actionId`.
- Biến: Ghi: `e2e_adjust_key`, `e2e_adj_tx`, `e2e_adj_action`. Đọc: `e2e_cust`.

### Bước 23 — Số dư = 40000 sau adjust

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi điều chỉnh trừ 10000.
- Kết quả mong đợi: `200`; `balance` `40000`.
- Biến: Đọc: `e2e_cust`.

### Bước 24 — Đảo giao dịch adjust

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/ops/transactions/{{e2e_adj_tx}}/reversals`
- Làm gì: Đảo giao dịch điều chỉnh vừa tạo.
- Kết quả mong đợi: `201`; `reversesTransactionId` bằng giao dịch adjust.
- Biến: Ghi: `e2e_reverse_key`, `e2e_rev_action`. Đọc: `e2e_adj_tx`.

### Bước 25 — Số dư về 50000 sau khi đảo

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi đảo giao dịch.
- Kết quả mong đợi: `200`; `balance` `50000`.
- Biến: Đọc: `e2e_cust`.

### Bước 26 — Nhật ký ops có đủ 5 thao tác

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/ops/actions?limit=50`
- Làm gì: Đọc nhật ký thao tác ops (mới nhất trước) và kiểm 5 thao tác của luồng này đều có.
- Kết quả mong đợi: `200`; có đủ 5 `actionId` của luồng với đúng loại `FREEZE`, `UNFREEZE`, `REPLAY_PAID`, `ADJUST`, `REVERSE`.
- Biến: Đọc: `e2e_frz_action`, `e2e_unfrz_action`, `e2e_replay_action`, `e2e_adj_action`, `e2e_rev_action`.
- Lưu ý:
  - Nếu có người khác chạy ops song song trên cùng tenant, tăng `limit` (tối đa 200).

## Kiểm tra cuối luồng

- Ví đóng băng thì order bị từ chối `WALLET_FROZEN`; mở băng thì cùng `orderId` thành công.
- Replay-paid phát lại đúng `eventId` gốc và không đổi số dư.
- Nhật ký ops có đủ 5 thao tác.
