# ADR-0007: Nạp tiền gọi payment kiểu lai và chống trùng nhiều lớp

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Nạp tiền là thao tác gọi một hệ thống ngoài có thể chậm, lỗi hoặc gửi webhook trùng/muộn. Tiền không được ghi hai
lần, không được mất, và `POST /topups` phải trả lời nhanh.

## Quyết định

`POST /topups` trong một transaction ghi lần nạp `REQUESTED` và idempotency key, trả `202`, rồi **sau khi commit**
kích hoạt một lần thử gửi sang payment không chờ. Một worker định kỳ gửi lại các lần nạp `REQUESTED` đến hạn. Cả hai
dùng chung `SubmitTopup`: chiếm lần nạp bằng lease 60 giây (`UPDLOCK, READPAST`), gọi payment ngoài transaction với
`Idempotency-Key = topup:<tenant>:<topupId>`, ghi kết quả trong transaction mới (bỏ qua nếu webhook đã chốt trước).
Lỗi 4xx → `FAILED`/`PAYMENT_REJECTED` ngay; lỗi mạng, timeout, 5xx → retry theo `TOPUP_SUBMIT_BACKOFF`, hết lượt →
`FAILED`/`PAYMENT_UNAVAILABLE`. Webhook là nguồn sự thật về tiền: `charge.succeeded` đến muộn vẫn chuyển
`FAILED`/`PAYMENT_UNAVAILABLE` thành `SUCCEEDED` và ghi sổ.

Chống trùng khi ghi tiền theo lớp: idempotency key API `(customer, key)` + hash nội dung; idempotency key gửi payment;
inbox `processed_messages(eventId)`; trạng thái lần nạp + khóa dòng; `business_key = topup:<id>` duy nhất trong
ledger; `UPDLOCK` tài khoản theo thứ tự id; trigger bất biến và `CHECK` số dư.

## Phương án đã loại

- Gọi payment đồng bộ trong request: giữ kết nối và khóa khi payment chậm, mất kết quả khi lỗi giữa chừng.
- Chỉ dùng worker: trễ tối thiểu một chu kỳ cho mọi lần nạp.
- Outbox/message bus: hoãn sang Bước 4 (thanh toán order với ecommerce) nơi nó thật sự cần.

## Hệ quả

Nếu tiến trình chết giữa lúc gửi, lần nạp tự đến hạn lại sau lease và được gửi lại an toàn nhờ idempotency key của
payment. Một webhook có thể đến trước khi kết quả gọi được ghi; trạng thái `REQUESTED` vẫn được chốt đúng. Dừng
service chờ các lần thử gửi ngay đang chạy rồi mới đóng DB.
