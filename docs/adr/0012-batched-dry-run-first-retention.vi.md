# ADR-0012: Dọn dữ liệu cũ bằng lô nhỏ trong từng service, chạy thử là mặc định, không bao giờ xóa dữ liệu tài chính

**Trạng thái:** Chấp nhận — 2026-10-12

## Bối cảnh

Sau các bước trước, nhiều bảng của wallet và payment chỉ tăng: outbox `SENT` (ADR-0009 ghi nhận là chưa dọn), `processed_messages`
(inbox khử trùng), `idempotency_keys`, lịch sử đối soát đã đóng (ADR-0010) và webhook đã giao. Cần giữ chúng bị chặn trên mà không
bao giờ làm yếu khử trùng, không chạm vào sổ cái hay các bảng tiền, và không gây khóa dài trên đường xử lý chính (thanh toán
order, nạp tiền). Xóa là thao tác không hoàn tác, nên việc bật nó phải do người vận hành chủ động.

## Quyết định

- **Xóa theo lô nhỏ**: mỗi lô là `delete top (N) ... with (readpast, rowlock)` trong một transaction ngắn (`N` tối đa 4000, dưới
  ngưỡng nâng cấp khóa của SQL Server); lặp tới khi lô ngắn, hết ngân sách thời gian hoặc bị hủy. `readpast` bỏ qua dòng đang bị
  khóa nên retention không chặn đường chính. Cutoff tính từ `Clock` được tiêm, không dùng đồng hồ SQL Server.
- **Mỗi service một worker và một use case `RunRetention`** ở tầng `application`, đi qua cổng `RetentionRepository`; SQL nằm ở
  `infrastructure` (một nơi cho cả đếm và xóa để hai chế độ không lệch). Dùng `Worker` riêng để lượt dọn dài không chặn việc gửi
  outbox hay đối soát. `drainBatches` ở `@billing/runtime` là vòng lặp lô dùng chung.
- **Chạy thử là mặc định**: `RETENTION_ENABLED=true` nhưng `RETENTION_DRY_RUN=true`; chế độ này chỉ đếm (có trần 1.000.000 mỗi
  chính sách) và không xóa gì. Người vận hành tự đặt `RETENTION_DRY_RUN=false` sau khi xem số `would_delete`.
- **Thời hạn mặc định thận trọng và có mức tối thiểu được kiểm tra khi khởi động**: ví dụ outbox `SENT` 14 ngày (tối thiểu 1),
  `processed_messages` 30 ngày (tối thiểu 7), `idempotency_keys` 90 ngày (tối thiểu 7), đối soát 365 ngày (tối thiểu 30), webhook
  30 ngày (tối thiểu 1). Giá trị sai làm service từ chối khởi động. Bảng đầy đủ: [retention](../ops/retention.vi.md).
- **Không bao giờ xóa bảng tài chính** (`ledger_transactions`, `ledger_entries`, `accounts`, `topups`, `order_payments`,
  `charges`), và giữ mọi dòng chưa xong (mục `OPEN`, lượt `RUNNING`, outbox `PENDING`, webhook `PENDING`/`FAILED`). Danh sách bảng
  mà từng chính sách đụng tới là dữ liệu và bị test khẳng định không chứa bảng cấm; test tích hợp chứng minh số dòng các bảng đó
  không đổi sau một lượt đầy đủ.
- **Quan sát**: counter `billing.retention.rows{table, mode[, tenant]}` (`mode` = `deleted` hoặc `would_delete`) và gauge
  `billing.retention.last_success_timestamp_seconds` đặt về epoch giây của lượt thành công gần nhất (một lượt có lỗi không làm
  mới nó); rule Kibana `billing-retention-stalled` báo khi giá trị cũ hơn `maxAgeHours`, cùng hai panel dashboard. Sinh từ code
  như ADR-0011.

## Phương án đã loại

- **Phân vùng bảng (sliding window) rồi bỏ cả phân vùng:** xóa rất rẻ nhưng cần chuyển bảng đang có sang bảng phân vùng, tức là
  migration ngoại tuyến, và ràng buộc khóa chính/khóa ngoại phải chứa cột phân vùng. Quá nặng so với lượng dữ liệu hiện tại.
- **Archive trước khi xóa:** thêm nơi lưu, quy trình khôi phục và bảo mật mới cho dữ liệu vốn đã hết giá trị nghiệp vụ; sổ cái
  (nguồn sự thật) không bị xóa. Chưa có yêu cầu (YAGNI); bản sao lưu database là lớp bảo vệ khi bật xóa thật.
- **Một SQL Agent job toàn cục:** không di động (không phải môi trường nào cũng có SQL Agent, nhất là container và dịch vụ quản lý),
  nằm ngoài repo nên không review, không test và không biết danh sách tenant động của wallet. Job trong service dùng đúng cấu hình
  và `Clock`, và dùng được cho test tích hợp.
- **Xóa `processed_messages` cùng lượt với outbox:** hai bảng có chân trời an toàn khác nhau. Outbox `SENT` hết giá trị ngay sau
  khi đã giao (vài ngày là dư); `processed_messages` quyết định một message giao lại có bị xử lý lại hay không, nên giữ lâu hơn và
  có mức tối thiểu riêng.

## Hệ quả

- **Xóa không hoàn tác, không có archive.** Chế độ chạy thử mặc định và quy trình chuyển đổi trong
  [retention](../ops/retention.vi.md) là lớp bảo vệ chính; production phải sao lưu trước khi bật xóa thật.
- **Cửa sổ idempotency giờ hữu hạn và được ghi trong tài liệu**: cùng `Idempotency-Key` gửi lại sau `RETENTION_IDEMPOTENCY_KEYS_DAYS`
  ngày được coi là yêu cầu mới. Khử trùng message vẫn đúng sau khi dọn `processed_messages` nhờ `order_payments` và trạng thái
  `topups`, nhưng một message giao lại sau hơn `RETENTION_PROCESSED_MESSAGES_DAYS` ngày sẽ đi lại đường xử lý.
- **Nhiều pod có thể làm việc trùng** nhưng không sai nhờ `readpast`; bộ đếm của mỗi pod là riêng.
- **Số đếm của chế độ chạy thử có trần 1.000.000 mỗi chính sách và đếm thiếu ở các chính sách phụ thuộc** (`reconciliation_runs`
  khi còn item; `webhook_events` của payment khi lần thử còn tham chiếu), vì chế độ này không xóa gì để mở khóa dòng cha.
- **Tồn đọng lớn cần nhiều lượt**: mỗi lượt bị chặn bởi `RETENTION_MAX_SECONDS_PER_RUN`; có thể chỉnh lô, ngân sách và chu kỳ.
- **Cảnh báo "lâu không dọn" chỉ nổ cho service từng báo thành công** trong `lookbackHours` giờ qua: job tắt hoặc chưa từng chạy
  thì không có gauge nên không nổ, và rule tự hết sau `lookbackHours` giờ im lặng. Gauge dựa trên mốc thời gian nên lệch đồng hồ
  giữa service và Elasticsearch làm tuổi sai lệch tương ứng.
- Thêm index cho các câu xóa: wallet tenant migration `006-retention-indexes`, payment migration `003-retention-indexes`.
