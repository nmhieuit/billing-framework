# Giới thiệu hệ thống

## 1. Hệ thống làm gì

Billing gồm hai service độc lập:

| Service | Vai trò | Cổng mặc định |
| --- | --- | --- |
| **Wallet** | Ví nạp trước của khách hàng và sổ cái ghi sổ kép. Nhận yêu cầu nạp tiền, trừ ví khi thanh toán order, đối soát, và các công cụ vận hành | 3001 |
| **Payment** | Cổng thanh toán **giả lập**: tạo charge, hoàn tất theo kịch bản `X-Simulate`, gửi webhook về wallet, cung cấp sao kê | 3002 |

Ecommerce (hệ thống đặt hàng) không nằm trong stack test. Ecommerce giao tiếp với wallet bằng sự kiện qua RabbitMQ; khi test, QA đóng vai ecommerce.

Nhiều khách hàng (tenant) dùng chung hệ thống nhưng dữ liệu tách biệt hoàn toàn theo tenant. Tenant mặc định khi test là `acme` và `beta`.

Danh tính không dùng token: người gọi tự khai qua header `x-tenant-id`, `x-customer-id`; các route vận hành thêm `x-actor-id` và `x-actor-role: OPS`.

## 2. Các nghiệp vụ chính

### Ví

Mỗi khách hàng có tối đa một ví cho mỗi đồng tiền trong một tenant (`VND` hoặc `USD`). Số tiền luôn là số nguyên theo đơn vị nhỏ nhất. Tạo ví lặp lại cùng đồng tiền là idempotent; khác đồng tiền bị từ chối.

### Nạp tiền

Khách yêu cầu nạp tiền (`POST /topups`, bắt buộc có `Idempotency-Key`). Wallet nhận yêu cầu và trả `202` ngay, rồi gửi charge sang payment. Khi payment hoàn tất, nó gửi webhook (có chữ ký) về wallet; chỉ khi đó tiền mới được cộng vào ví và ghi sổ cái. Trạng thái của topup: `REQUESTED`, `PENDING`, `SUCCEEDED`, `FAILED`. Gửi lại cùng `Idempotency-Key` trả lại kết quả cũ và không cộng tiền lần hai.

### Thanh toán order

Khi một order sẵn sàng thanh toán, ecommerce gửi sự kiện `OrderReadyForPaymentV1` qua RabbitMQ. Wallet trừ ví đúng một lần cho mỗi `orderId`, rồi báo kết quả bằng `OrderPaidV1` (thành công) hoặc `OrderPaymentFailedV1` (từ chối, kèm lý do: `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`, `WALLET_FROZEN`). Message hỏng hoặc không xử lý được vào hàng đợi chết (DLQ).

### Đối soát

Mỗi ngày wallet đối soát ngày hôm trước (UTC) cho từng tenant: kiểm tra sổ cái nội bộ cân và so sao kê payment với các topup. Mỗi lượt chạy là bất biến; các điểm lệch được ghi thành "ca" (item), người vận hành có thể đóng ca bằng ghi chú. QA cũng có thể chạy đối soát bằng tay.

### Vận hành (ops)

Người vận hành có công cụ xử lý tình huống tiền bạc: đóng/mở băng ví (freeze/unfreeze), điều chỉnh số dư (adjustment, cộng hoặc trừ), đảo một giao dịch (reversal), phát lại sự kiện `OrderPaidV1` (replay-paid), xem nhật ký thao tác. Mọi thao tác đổi trạng thái được ghi vào nhật ký chỉ thêm, không sửa, không xóa. Các route này chỉ dành cho mạng vận hành.

### Retention và quan sát

Mỗi service có job nền xóa định kỳ dữ liệu đã hết giá trị (outbox đã gửi, inbox khử trùng, khóa idempotency, lịch sử đối soát đã đóng, webhook đã giao). Job bật sẵn ở chế độ chạy thử, chỉ đếm, không xóa, cho tới khi đặt `RETENTION_DRY_RUN=false`. Việc quan sát dùng Kibana (dashboard "Billing: vận hành" và các rule cảnh báo) và log của service.

## 3. Danh sách endpoint HTTP

20 đường dẫn, 21 request (`GET /health` có ở cả hai service).

| Service | Method | Path | Nhóm test |
| --- | --- | --- | --- |
| Wallet | GET | `/health` | Mọi nhóm |
| Wallet | POST | `/wallets` | Wallet |
| Wallet | GET | `/wallet` | Wallet |
| Wallet | GET | `/wallet/entries` | Wallet |
| Wallet | POST | `/topups` | Wallet |
| Wallet | GET | `/topups/:id` | Wallet |
| Wallet | POST | `/webhooks/payment` | Wallet |
| Wallet | POST | `/ops/wallets/:customerId/freeze` | Ops |
| Wallet | POST | `/ops/wallets/:customerId/unfreeze` | Ops |
| Wallet | POST | `/ops/wallets/:customerId/adjustments` | Ops |
| Wallet | POST | `/ops/transactions/:id/reversals` | Ops |
| Wallet | POST | `/ops/orders/:orderId/replay-paid` | Ops |
| Wallet | GET | `/ops/actions` | Ops |
| Wallet | POST | `/reconciliations` | Đối soát |
| Wallet | GET | `/reconciliations/:runId` | Đối soát |
| Wallet | GET | `/reconciliations/:runId/items` | Đối soát |
| Wallet | POST | `/reconciliation-items/:id/resolve` | Đối soát |
| Payment | GET | `/health` | Payment |
| Payment | POST | `/charges` | Payment |
| Payment | GET | `/charges/:id` | Payment |
| Payment | GET | `/settlements` | Payment |

Luồng RabbitMQ (`OrderReadyForPaymentV1`, `OrderPaidV1`, `OrderPaymentFailedV1`) không gọi bằng HTTP; xem [`test-case/order-payment.md`](test-case/order-payment.md).

## 4. Các tài liệu test

| Nghiệp vụ | Tài liệu |
| --- | --- |
| Ví, nạp tiền, sổ cái, tenant, webhook | [`test-case/wallet.md`](test-case/wallet.md) |
| Cổng thanh toán giả lập | [`test-case/payment-simulator.md`](test-case/payment-simulator.md) |
| Thanh toán order (RabbitMQ) | [`test-case/order-payment.md`](test-case/order-payment.md) |
| Công cụ vận hành | [`test-case/ops.md`](test-case/ops.md) |
| Đối soát | [`test-case/doi-soat.md`](test-case/doi-soat.md) |
| Retention và quan sát | [`test-case/retention-quan-sat.md`](test-case/retention-quan-sat.md) |
| Chaos | [`test-case/chaos.md`](test-case/chaos.md) |
