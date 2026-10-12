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
