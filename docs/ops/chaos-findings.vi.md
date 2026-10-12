# Kết quả chaos test

Tài liệu ghi các phát hiện và ghi chú vận hành rút ra từ bộ chaos test (`tests/chaos`). Mỗi lỗi thật chưa sửa sẽ có một mục riêng (hiện chưa có lỗi thật nào).

## Ghi chú vận hành

Đây là ghi chú vận hành, **không phải lỗi**.

### Đơn ĐÃ trả vẫn có thể rơi vào DLQ của `wallet.order-payments` (kịch bản S3)

- Hiện tượng: nếu consumer thất bại SAU khi `PayOrder` đã commit (ví dụ lỗi trước ack, mất kết nối, móc xử lý ném lỗi) đủ số lần vượt `retryDelaysSeconds` (mặc định cấu hình harness `[1, 2]` = tối đa 3 lần xử lý), message bị chuyển vào DLQ `wallet.order-payments.dlq` dù khoản trả đã ghi từ lần đầu. Các lần giao lại đều ra `DUPLICATE` (dòng inbox `processed_messages` đã có) nên không ghi nợ lần hai.
- Tác động: cảnh báo DLQ có thể kêu cho đơn mà tiền đã trừ đúng một lần; `OrderPaidV1` vẫn nằm trong outbox và được relay gửi như bình thường.
- Cách xử lý: trước khi làm gì với message trong DLQ, kiểm tra `order_payments` (và `processed_messages`) của tenant theo `orderId`/`eventId`. Nếu đã có khoản trả thì không cần can thiệp tiền.
- Phát lại từ DLQ là vô hại: message cùng `eventId` sẽ ra `DUPLICATE`, không ghi nợ lại.
- Tái hiện: `tests/chaos/scenarios-sql-broker.chaos.test.ts`, test "S3: consumer dies before ack three times (retries exhausted)".

### Webhook hết lượt gửi thì topup treo `PENDING` tới lần đối soát kế tiếp (kịch bản S7, S9)

Đây là ghi chú vận hành, **không phải lỗi**.

- Hiện tượng: payment gửi webhook theo `WEBHOOK_BACKOFF`, mặc định production `1,5,30,120,600` giây (xem `services/payment/.env.example` và `services/payment/src/config.ts`) = 6 lần gửi trong khoảng 756 giây (~12,6 phút). Sau lần thất bại cuối, sự kiện chuyển `FAILED` và được giữ lại để điều tra, payment không gửi nữa. Nếu wallet chết, hoặc đường payment → wallet hỏng, lâu hơn khoảng đó thì charge đã `SUCCEEDED` nhưng topup của wallet vẫn `PENDING` (ví chưa được ghi có).
- Tác động: tiền khách đã bị thu nhưng ví chưa tăng cho tới lần đối soát tự động kế tiếp (chạy một lần mỗi ngày, tối đa khoảng một ngày), trừ khi vận hành viên chạy đối soát thủ công. Cảnh báo `billing-topups-stuck` sẽ kêu khi topup chờ quá ngưỡng.
- Cách xử lý: chạy đối soát thủ công `POST /reconciliations` (ngày chứa charge); với `RECONCILE_AUTOFIX` bật, đối soát ghi bù đúng một lần (`MISSING_AT_WALLET` thành `AUTO_APPLIED`). Các bước chi tiết: [reconciliation-runbook](../integration/reconciliation-runbook.vi.md).
- Cửa sổ lease 60 giây (theo thiết kế, không cần can thiệp): sau khi wallet chết giữa lúc gửi sang payment, topup chỉ được gửi lại khi lease 60 giây của lần chiếm trước hết hạn; sau khi payment chết giữa lúc gửi webhook, sự kiện chỉ đến hạn gửi lại khi lease 60 giây hết. Gửi lại dùng cùng khóa idempotency nên payment không tạo charge thứ hai.
- Tái hiện: `tests/chaos/scenarios-payment-crash.chaos.test.ts`, test S7 (mất toàn bộ webhook, đối soát ghi bù đúng một lần) và S9 (SIGKILL wallet, gửi lại cùng khóa).