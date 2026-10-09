# ADR-0005: Payment hoàn tất charge và gửi webhook bằng worker poll DB, có lease

**Trạng thái:** Chấp nhận — 2026-10-09

## Bối cảnh

Payment giả lập phải bền vững qua restart, tái tạo được lỗi giữa chừng (mất webhook, webhook trùng, retry) và
chạy an toàn khi có nhiều instance. `POST /charges` không được chờ kết quả cuối.

## Quyết định

`POST /charges` chỉ ghi charge `PENDING` kèm `due_at`. Một worker poll SQL Server: (1) hoàn tất charge đến hạn và
ghi `webhook_events` trong cùng một transaction; (2) với sự kiện webhook, mỗi lần chỉ "chiếm" một sự kiện, ngay trước
khi gửi: khóa một sự kiện đến hạn bằng `UPDLOCK, READPAST`, đẩy `next_attempt_at` thêm một lease (60 giây), gửi HTTP
ngoài transaction, rồi ghi kết quả trong một transaction mới; mỗi chu kỳ lặp tối đa `limit` lần. Chọn việc trên index
`(status, due_at, id)` / `(status, next_attempt_at, event_id)`.

## Phương án đã loại

- Hẹn giờ trong bộ nhớ (`setTimeout`): mất khi restart, không kiểm tra được kịch bản "restart giữa chừng".
- Gửi webhook ngay trong transaction hoàn tất: giữ khóa DB trong lúc chờ mạng, và mất sự kiện nếu gửi thất bại.

## Hệ quả

Charge hoàn tất trễ tối đa một chu kỳ worker (mặc định 500 ms). Retry gồm lần gửi đầu cộng tối đa
`len(WEBHOOK_BACKOFF)` lần thử lại. Vì mỗi sự kiện được chiếm riêng ngay trước khi gửi, lease chỉ cần phủ một lần gửi
chứ không phải cả lô. Nếu tiến trình chết khi đang gửi, sự kiện tự đến hạn lại sau lease (60 giây) và có thể được gửi
lặp; người nhận phải khử trùng theo `eventId`. `Worker.tick()` nuốt lỗi do chính `onError` ném ra để vòng lặp và
`stop()` không bao giờ bị gãy. `stop()` của service idempotent và chịu lỗi (dừng lần lượt worker, app, db, luôn thử cả
ba và ném lại lỗi đầu tiên), còn trình xử lý tắt máy bỏ qua tín hiệu lặp lại.
