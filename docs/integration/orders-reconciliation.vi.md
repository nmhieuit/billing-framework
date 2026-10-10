# Hợp đồng đối soát Wallet ↔ Orders

## Mục đích và trạng thái

Spec nền tảng (mục 6.3) định nghĩa ba phép đối soát; hai phép đầu (ledger nội bộ và Wallet ↔ Gateway) đã chạy ở Bước 5.
Phép thứ ba, Wallet ↔ Orders, **chưa chạy** vì ecommerce chưa có dữ liệu để đối chiếu. Tài liệu này là hợp đồng để hai bên
làm theo khi ecommerce sẵn sàng. Nó không chặn việc triển khai thanh toán order (Bước 4).

## Snapshot ecommerce cần cung cấp

Danh sách order ở trạng thái `Paid` trong **một ngày UTC**, theo tenant. Mỗi dòng gồm:

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `orderId` | UUID | Khóa đối chiếu với `order_payments` của wallet |
| `customerId` | chuỗi | |
| `amount` | số nguyên | Đơn vị nhỏ nhất của đồng tiền |
| `currency` | `VND` \| `USD` | |
| `paidAtUtc` | RFC 3339 | Thời điểm order chuyển `Paid` |
| `walletTransactionId` | chuỗi | Lấy từ `OrderPaidV1` |

Hai hình thức đề xuất, team ecommerce chọn:

- (a) endpoint chỉ đọc, phân trang cursor: `GET …?tenantId=&date=&cursor=`;
- (b) file xuất theo ngày.

## Quy tắc đối chiếu wallet sẽ áp dụng khi có snapshot

Mỗi `ORDER_PAYMENT` (bảng `order_payments`) phải có order `Paid` khớp `orderId`, số tiền và đồng tiền, và ngược lại. Loại
lệch dự kiến:

| Loại lệch | Nghĩa | Xử lý |
|---|---|---|
| `PAID_ONLY_AT_WALLET` | Wallet đã trừ, order chưa `Paid` | Phát lại `OrderPaidV1` từ outbox (cần công cụ phát lại, **chưa có**) |
| `PAID_ONLY_AT_ORDERS` | Order `Paid` mà wallet không có bút toán | Ca thủ công |
| `ORDER_AMOUNT_MISMATCH` | Khác số tiền hoặc đồng tiền | Ca thủ công |

## Ràng buộc

- `Paid` là trạng thái cuối.
- Đối soát chỉ báo lệch, **không** tự đổi trạng thái order.
- Kết quả đến sai thứ tự là bình thường (`OrderPaymentFailedV1` có thể đến sau `OrderPaidV1`), xem
  [tài liệu bàn giao Bước 4](orders-handoff.vi.md). Snapshot phải phản ánh trạng thái, không phải thứ tự đến.

## Câu hỏi mở cho ecommerce

- Hình thức cung cấp snapshot: endpoint hay file.
- Độ trễ chấp nhận được giữa `OrderPaidV1` và việc order xuất hiện trong snapshot.
- Cách định danh tenant trong snapshot (phải khớp `WALLET_TENANTS` của wallet).
