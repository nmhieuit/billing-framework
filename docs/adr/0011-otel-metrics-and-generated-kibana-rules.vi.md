# ADR-0011: Metric OpenTelemetry đẩy OTLP, gauge trạng thái do service tự đo, rule và dashboard Kibana sinh từ code

**Trạng thái:** Chấp nhận — 2026-10-11

## Bối cảnh

Billing đã có outbox, DLQ, nạp tiền và đối soát, nhưng người vận hành chỉ biết sự cố qua log hoặc khi ecommerce phàn nàn. Cần
thấy sức khỏe của chúng trên Kibana, nhận cảnh báo khi vượt ngưỡng, và chỉnh ngưỡng mà không sửa code hay import tay mỗi lần.
Nền tảng đã có đường OpenTelemetry → collector → Elasticsearch → Kibana (cùng đường với ecommerce).

## Quyết định

- **OTel SDK đẩy OTLP/gRPC tới collector**, cùng đường với ecommerce. `initTelemetry` trong `@billing/observability` đọc
  `OTEL_EXPORTER_OTLP_ENDPOINT`; không đặt thì no-op, nên test và chạy trần không đổi. Mỗi tiến trình có `service.instance.id`
  riêng (mỗi lần khởi động một chuỗi mới).
- **Counter ghi tại chỗ sự kiện xảy ra; gauge trạng thái do một worker riêng của từng service lấy mẫu định kỳ** (mặc định 15 giây,
  `METRICS_SAMPLE_INTERVAL_SECONDS`) bằng truy vấn nhẹ vào DB và broker. Lỗi khi lấy mẫu chỉ log và bỏ qua chu kỳ đó.
- **Mỗi service một cổng `Metrics` ở tầng `application`**; adapter OTel nằm ở `infrastructure`. `application` và `domain` không
  nhập OpenTelemetry (ESLint chặn). `Metrics.prime` khởi tạo các chuỗi counter ở 0 (ví dụ lượt đối soát `FAILED`) để lần tăng đầu tiên nhìn thấy được như một mức tăng.
- **Rule cảnh báo và dashboard sinh từ code** (`tools/kibana`) với **ID cố định** theo tên, mọi điều kiện là tham số
  (`params.defaults.json` cộng `params.local.json`), áp lên Kibana đang chạy bằng `kibana:apply` qua Alerting API và Saved Objects
  API (cập nhật tại chỗ, không xóa rule). Truy vấn là ES|QL; yêu cầu Kibana/Elasticsearch từ 9.4 vì `SET unmapped_fields="nullify";`
  và Lens ES|QL.
- Giá trị hiện tại dùng `LAST(field, @timestamp)`; counter được gộp bằng MAX trong mỗi bucket trên dashboard, còn rule đối soát lỗi
  cộng mức tăng của từng tiến trình (hai bước `STATS`).

## Phương án đã loại

- **Prometheus `/metrics`:** không phải đường của nền tảng (collector và Elastic đã là chuẩn của ecommerce); thêm một hệ thống
  scrape chỉ cho billing.
- **File JSON export tay, bảo trì bằng tay:** lệch khỏi code, không review được, đổi ngưỡng là sửa tay và import lại. Sinh từ code
  cho phép test (ID ổn định, truy vấn chạy được trên Elasticsearch thật, file commit bằng đúng bản sinh ra).
- **Bầu chọn leader cho bộ lấy mẫu mỗi pod (một pod đo, các pod khác im):** thêm phối hợp phân tán cho một truy vấn rẻ. Mỗi pod
  tự đo cùng giá trị; rule và dashboard dùng MAX hoặc `LAST` nên không đếm đôi (YAGNI).
- **Metric từ log hoặc từ truy vấn thẳng DB trong Kibana:** Kibana không truy vấn được SQL Server; log không đo được "tuổi cái cũ nhất".

## Hệ quả

- **Counter tích lũy và về 0 khi service khởi động lại.** Chuỗi mới theo `service.instance.id` tránh trộn lẫn bản trước; biểu đồ
  thấy "tụt" sau deploy là bình thường (ghi trong tài liệu vận hành).
- **Tên trường trong Elasticsearch phụ thuộc mapping `otel` của collector** (`metrics.<tên>`, `attributes.<nhãn>`,
  `resource.attributes.service.name`); đổi collector hoặc mapping thì phải sửa `tools/kibana/fields.ts` (một nơi) và kiểm chứng
  bằng `kibana:verify`. Ghi nhận ở [metric-fields](../ops/metric-fields.md).
- **Cấu trúc saved object gắn với Kibana 9.4.x** (đã kiểm chứng trên 9.4.4); `kibana:apply` từ chối stack cũ hơn
  `MIN_STACK_VERSION`. Stack mới hơn có thể đổi định dạng.
- **Gauge biến mất khi DB sập** (không có truy vấn thì không có mẫu); `billing-service-silent` bắt trường hợp service ngừng gửi
  hẳn, nhưng không bắt được "DB sập mà service vẫn sống" từ gauge riêng lẻ.
- **Giá trị `LAST` có thể giữ rule active tối đa một cửa sổ** sau khi một chuỗi ngừng được báo (ví dụ số mục mở của một loại lệch
  từ 1 về 0).
- **Chưa có connector thông báo:** rule chỉ tạo alert trong Kibana; email/Slack là hạ tầng của người vận hành. Sửa tay trên giao
  diện bị `apply` lần sau ghi đè, và `apply` không quản lý `actions`.
- Mỗi pod lấy mẫu lặp truy vấn DB theo số pod; chấp nhận được vì truy vấn nhẹ, có index (migration `005-reconciliation-open-index`).
