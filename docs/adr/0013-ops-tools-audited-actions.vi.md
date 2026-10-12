# ADR-0013: Công cụ vận hành có kiểm toán: actor từ gateway, sổ cái chỉ thêm, phát lại giữ nguyên `eventId`

**Trạng thái:** Chấp nhận — 2026-10-12

## Bối cảnh

Sau đối soát (ADR-0010) và retention (ADR-0012), người vận hành đã thấy được sai lệch nhưng chưa có cách sửa an toàn: khách báo nhầm
tiền, một order trả nhầm cần hoàn tác, Orders mất `OrderPaidV1`. Làm bằng tay trên database vi phạm sổ cái bất biến (ADR-0002) và
không để lại dấu vết. Cần một nhóm thao tác hẹp, có danh tính người làm, lý do, idempotency và nhật ký, mà không phá các bất biến
tiền bạc đã có.

## Quyết định

- **Actor lấy từ header do gateway đặt, không từ body.** `x-actor-id` và `x-actor-role: OPS` (cùng mô hình tin gateway của
  `x-tenant-id`/`x-customer-id`); `OpsGuard` đòi cả hai, role khác `OPS` bị từ chối, header nhiều giá trị bị nối lại nên không lách
  được. Trường `actor` trong body bị bỏ qua. Gateway phải xóa mọi `x-actor-*` do client gửi.
- **Nhật ký `ops_actions` chỉ thêm, kiêm bảng idempotency.** Mỗi thao tác đổi trạng thái ghi một dòng trong **cùng transaction** với
  thay đổi; trigger `instead of update, delete` chặn sửa/xóa. `idempotency_key` là unique trong tenant, kèm `fingerprint` (SHA-256 của
  thao tác, đối tượng và tham số): cùng khóa cùng nội dung thì trả lại `result` đã lưu, khác nội dung thì `409 IDEMPOTENCY_CONFLICT`;
  va chạm unique khi chạy song song được thử lại một lần (như `PayOrder`). Thao tác no-op (đã đúng trạng thái đóng băng) không ghi.
  Danh sách phân trang theo `seq` (identity), không theo `created_at`, nên thứ tự ổn định và không cần thêm chỉ mục thời gian.
- **Điều chỉnh có đối ứng tài khoản hệ thống `ADJUSTMENT`; đảo bằng giao dịch đối nghịch.** `ADJUSTMENT` là giao dịch hai dòng giữa
  ví và `system:ADJUSTMENT:<cur>` (số dư không ràng buộc dấu); `REVERSAL` là giao dịch mới đảo dấu từng dòng của giao dịch gốc và
  trỏ về nó bằng `reverses_transaction_id` (chỉ mục unique có lọc: mỗi giao dịch chỉ bị đảo một lần). Sổ cái vẫn chỉ thêm và vẫn cân.
  Chỉ `ORDER_PAYMENT` và `ADJUSTMENT` đảo được.
- **Đóng băng chỉ chặn ghi nợ khi trả order.** Sau khi khóa ví, `PayOrder` thấy `frozen_at` thì từ chối bằng
  `OrderPaymentFailedV1(WALLET_FROZEN)` (sau nhánh "đã trả" nên order đã trả vẫn phát lại được). Nạp tiền, điều chỉnh và đảo vẫn chạy.
- **Phát lại giữ nguyên `eventId` nhờ `order_payments.paid_event_id`.** Cột này lưu `eventId` của `OrderPaidV1` ban đầu (outbox gốc có
  thể đã bị retention dọn). Phát lại ghi một dòng outbox với id mới nhưng payload mang `eventId` và thời điểm gốc, không đụng sổ cái.
  Hệ quả là `messageId` AMQP (id dòng outbox) khác `eventId` ở bản phát lại, nên consumer khử trùng theo `eventId` của payload.
- **Quan sát tối thiểu:** counter `billing.ops.actions{tenant, action, outcome}` (`ok`/`noop`/`rejected`) và một dòng log `info` cho mỗi
  thao tác thành công. Không thêm rule Kibana; `ops_actions` là nguồn kiểm toán.

## Phương án đã loại

- **Actor trong body:** người gọi tự khai, không có gì buộc nó khớp danh tính đã xác thực; sai ngay mục đích của kiểm toán.
- **API key riêng cho ops:** thêm một cơ chế bí mật cần cấp phát, xoay vòng và lưu, trong khi mô hình tin gateway đã tồn tại và đủ cho
  mạng vận hành; chỉ thêm bề mặt tấn công.
- **Sửa hoặc xóa dòng sổ cái để "sửa lỗi":** phá bất biến của ADR-0002 (đã có trigger chặn) và xóa dấu vết; mọi hiệu chỉnh phải là
  bút toán mới.
- **Đảo giao dịch `TOPUP`:** đối soát Wallet ↔ Gateway so `topups` với sao kê payment và chưa biết hiểu một giao dịch đảo; cần dạy
  đối soát trước. Tạm thời thu hồi tiền nạp nhầm bằng điều chỉnh `DEBIT`.
- **Đóng băng chặn cả ghi có (nạp tiền):** làm mất tiền khách đang chuyển và khiến webhook nạp tiền kẹt; mục tiêu chỉ là dừng việc
  tiêu tiền khi đang điều tra.
- **`eventId` mới khi phát lại:** Orders sẽ không nhận ra đó là cùng một khoản trả và có thể xử lý hai lần; giữ `eventId` cho phép
  khử trùng an toàn.

## Hệ quả

- **Thay đổi hợp đồng `WALLET_FROZEN`:** `OrderPaymentFailedV1.reason` có thêm giá trị mới; consumer kiểm tra enum chặt sẽ từ chối.
  Orders phải triển khai xử lý "lý do lạ là thất bại, giữ `Unpaid`" **trước** khi bật freeze ở môi trường dùng chung.
- **Đơn cũ có thể không phát lại được:** order trả trước migration `007-ops-tools` mà outbox gốc đã bị dọn không có `paid_event_id`;
  `replay-paid` trả `409 EVENT_ID_UNKNOWN` thay vì đoán.
- **Không có sự kiện hoàn tiền:** đảo thanh toán order không báo cho Orders; ops phải tự báo cho tới khi có hợp đồng mới (kiểu
  `OrderRefundedV1`).
- **Tin gateway cho header actor:** `ops_actions.actor` chỉ đáng tin bằng gateway; triển khai thật phải xóa `x-actor-*` của client.
- **Phát lại và đảo được tuần tự hóa bằng khóa hàng ví:** `replay-paid` khóa ví của khách (cùng hàng mà `ReverseTransaction` giữ cho
  `ORDER_PAYMENT`) trước khi kiểm tra đã-đảo, nên phát lại chạy đúng lúc đảo sẽ chờ rồi bị từ chối `ORDER_REVERSED`.
- **`ops_actions` không bị retention dọn** và bảng lớn dần theo số thao tác (rất ít so với giao dịch); đổi lại bằng chứng kiểm toán
  được giữ nguyên.
- **`noop` của metric gộp hai nghĩa** (đã đúng trạng thái và phát lại theo idempotency), nên không dùng để phát hiện lỗi.
- Hướng dẫn vận hành: [ops-tools](../ops/ops-tools.vi.md); thiết kế: [spec 6c](../superpowers/specs/2026-10-12-ops-tools-design.md).
