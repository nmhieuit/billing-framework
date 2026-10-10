# Bước 6a — Metric, cảnh báo và stack local một lệnh: thiết kế

**Ngày:** 2026-10-11
**Trạng thái:** Chờ duyệt
**Phạm vi:** Metric OpenTelemetry cho wallet và payment (đẩy OTLP), rule cảnh báo và dashboard Kibana có tham số điều chỉnh được, stack local chạy bằng một lệnh `docker compose`. Là vòng đầu của Bước 6 (vận hành); các vòng 6b dọn dữ liệu, 6c công cụ vận hành, 6d chaos, 6e tối ưu `MERCHANT` có spec riêng. Dựa trên spec nền tảng (`2026-10-09-billing-framework-design.md`, mục 6–8) và đối soát (`2026-10-10-reconciliation-design.md`).

## 1. Mục tiêu và quyết định đã chốt

Người vận hành thấy được sức khỏe của billing (hàng đợi chết, outbox, nạp tiền, đối soát) trên Kibana, nhận alert khi vượt ngưỡng, và chỉnh ngưỡng mà không phải sửa code hay import tay.

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Cách xuất metric | OpenTelemetry SDK, đẩy OTLP/gRPC tới collector rồi vào Elasticsearch (đúng spec nền: OTel → Elastic, cùng đường với ecommerce) |
| 2 | Loại tín hiệu | Chỉ **metric**. Trace và log OTel, SLO và ngân sách lỗi cho billing không thuộc 6a |
| 3 | Gauge trạng thái | Do từng service tự đo định kỳ bằng truy vấn nhẹ (DB, broker); mỗi pod báo cùng giá trị, rule dùng MAX |
| 4 | Cảnh báo | Rule Kibana `.es-query` (ES\|QL) và dashboard Lens ES\|QL, định dạng saved object của Kibana 9.4.4, **sinh từ code** với ID cố định |
| 5 | Điều chỉnh | Mọi điều kiện là tham số (`params.defaults.json` + `params.local.json` git-ignored); `kibana:apply` cập nhật tại chỗ rule và dashboard đang chạy |
| 6 | Stack local | `deploy/compose.infra.yml` (hạ tầng), `deploy/compose.services.yml` (wallet, payment), `deploy/compose.local.yml` (`include` cả hai); một lệnh `docker compose up` |
| 7 | Service trong container | Một `deploy/Dockerfile.dev` chỉ dùng cho local; chỉ bind-mount các thư mục `src` (chỉ đọc) để `tsx watch` nạp lại, không mount cả repo |
| 8 | Thông báo | Rule chỉ tạo alert trong Kibana. Connector (email, Slack) là hạ tầng của người vận hành, ngoài phạm vi |

## 2. Metric trong code

### 2.1 Cấu trúc

- `packages/observability` thêm `initTelemetry({ serviceName })`: dùng OTel SDK với exporter OTLP/gRPC, đọc `OTEL_EXPORTER_OTLP_ENDPOINT` và `OTEL_SERVICE_NAME`. Khi không đặt endpoint thì **no-op** (test và chạy trần không đổi). Dừng êm khi service tắt (flush).
- `application` chỉ biết port `Metrics` (các hàm đếm sự kiện); adapter OTel nằm ở `infrastructure`. `domain` không đổi.
- Bộ đếm ghi ngay tại chỗ sự kiện xảy ra. Gauge do `StateSampler` của từng service tính định kỳ (mặc định 15 s, cấu hình được) bằng truy vấn nhẹ; lỗi khi lấy mẫu chỉ log và bỏ qua chu kỳ đó, không làm hỏng service.
- Cấu hình thêm: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `METRICS_SAMPLE_INTERVAL_SECONDS` (mặc định 15). Vào `.env.example` và được `env-example.test.ts` kiểm.

### 2.2 Danh mục (tiền tố `billing.`, nhãn `tenant` khi có nghĩa)

| Nhóm | Metric | Loại | Nguồn |
|---|---|---|---|
| Order | `order_payments` theo `outcome` (`paid`, `failed:<reason>`, `replayed`) | counter | `PayOrder` |
| Consumer | `consumer.messages` theo `result` (`processed`, `retried`, `dead_lettered`, `rejected`) | counter | `packages/messaging` consumer |
| DLQ | `dlq.depth` (queue `wallet.order-payments.dlq`) | gauge | passive declare AMQP (không cần quyền management) |
| Outbox | `outbox.pending`, `outbox.oldest_age_seconds` | gauge | truy vấn bảng `outbox` mỗi tenant |
| Nạp tiền | `topups` theo `outcome`; `topups.requested_backlog`, `topups.oldest_requested_age_seconds` | counter, gauge | `ApplyPaymentResult`, `SubmitTopup`; truy vấn `topups` |
| Đối soát | `reconciliation.runs` theo `status`; `reconciliation.open_items` theo `kind`; `reconciliation.oldest_open_item_age_seconds`; `reconciliation.last_success_age_seconds` | counter, gauge | `RunReconciliation`; truy vấn `reconciliation_*` |
| Payment | `payment.charges` theo `status`; `payment.webhook_failures`; backlog webhook chưa giao nếu dữ liệu sẵn có | counter, gauge | use case payment; truy vấn payment |

Tên cuối cùng của trường trong Elasticsearch (`metrics.billing.*`, `attributes.*`) do collector `mode: otel` quyết định và được xác nhận trên stack thật trước khi cố định ES|QL.

## 3. Rule cảnh báo và dashboard

### 3.1 Sinh từ code

`deploy/kibana/spec.ts` mô tả rule và panel; script sinh ra `deploy/kibana/billing-alerts.ndjson` và `billing-dashboard.ndjson` (commit, ứng với tham số mặc định). Test kiểm tra sinh lại thì giống file đã commit và ID ổn định giữa các lần sinh. Cấu trúc saved object lấy từ các file export của Kibana 9.4.4 bên ecommerce (`docs/kibana-quan-sat-he-thong`).

### 3.2 Rule (mỗi rule gắn tag `billing`; mô tả nêu runbook cần mở)

| Rule | Điều kiện (mặc định) | Mức độ | Runbook |
|---|---|---|---|
| `billing-dlq-not-empty` | `dlq.depth` > 0 liên tục 5 phút | critical | `dlq-runbook` |
| `billing-outbox-stuck` | `outbox.oldest_age_seconds` > 300 | high | `orders-handoff` |
| `billing-topups-stuck` | `topups.oldest_requested_age_seconds` > 300 | high | README wallet |
| `billing-ledger-integrity` | `open_items` loại `LEDGER_UNBALANCED` hoặc `BALANCE_MISMATCH` > 0 | critical | `reconciliation-runbook` |
| `billing-reconciliation-stale-cases` | mục `OPEN` có tuổi > 24 giờ | warning | `reconciliation-runbook` |
| `billing-reconciliation-missed` | `last_success_age_seconds` > 26 giờ, hoặc có lượt `FAILED` mới | high | `reconciliation-runbook` |
| `billing-service-silent` | wallet hoặc payment không gửi metric nào trong 5 phút | high | README |

### 3.3 Dashboard "Billing: vận hành"

Một dashboard (~10 panel, ES|QL): DLQ depth; tuổi cái cũ nhất của outbox theo tenant; thanh toán order theo kết quả; message consumer theo kết quả; backlog nạp tiền; mục lệch đối soát mở theo loại cùng tuổi lâu nhất; lần đối soát thành công gần nhất theo tenant; charge payment theo trạng thái và lỗi webhook; bảng alert đang bật của các rule `billing`. Đường ngưỡng và màu cảnh báo lấy cùng tham số với rule tương ứng.

### 3.4 Tham số và áp dụng lên Kibana đang chạy

- `deploy/kibana/params.defaults.json` (commit) chứa mọi mặc định; `params.local.json` (git-ignored) chỉ ghi các khóa muốn đổi. Mỗi rule có `enabled`, ngưỡng riêng, `windowMinutes`, `intervalMinutes`, `severity`; dashboard có `timeRange`. Có schema kiểm tra (sai kiểu, âm, ngoài khoảng bị từ chối kèm thông báo rõ trước khi gọi Kibana).
- `corepack pnpm kibana:apply [-- --dry-run]`: trộn tham số, sinh đối tượng, rồi **cập nhật tại chỗ** nhờ ID cố định. Rule: tạo nếu chưa có, ngược lại `PUT /api/alerting/rule/{id}` (giữ lịch sử alert và trạng thái bật/tắt; chỉ đổi theo `enabled` khi tham số chỉ định). Dashboard và data view: import với `overwrite=true`. `--dry-run` in ra sự khác biệt và không ghi.
- Đích lấy từ `KIBANA_URL` (mặc định theo cổng compose local); cùng lệnh dùng cho Kibana khác.
- `corepack pnpm kibana:build` xuất hai file `.ndjson` từ tham số hiện tại để import tay (Saved Objects → Import).
- Rule do ai đó sửa trực tiếp trên giao diện bị `apply` lần sau ghi đè về tham số; `--dry-run` cho thấy khác biệt đó. Rollback: xóa khóa trong `params.local.json` rồi `apply`.

## 4. Stack local một lệnh

```bash
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
```

- `compose.infra.yml`: SQL Server 2022, RabbitMQ (management), Elasticsearch 9.4.4 và Kibana 9.4.4 (một node, tắt security, `XPACK_ENCRYPTEDSAVEDOBJECTS_ENCRYPTIONKEY` đặt sẵn vì Alerting cần), OTel Collector contrib 0.160.0 (OTLP → Elasticsearch `mode: otel` + exporter `debug`; cấu hình `deploy/otel/collector-config.yaml`), job khởi tạo DB và RabbitMQ (dùng lại `sql/init.sql` và `scripts/init-rabbitmq.sh`), job `kibana-import` (chờ Kibana sẵn sàng rồi chạy `kibana:apply`; rule được tạo ở trạng thái bật hay tắt theo tham số `enabled`).
- `compose.services.yml`: job `migrate` (wallet, payment bằng tài khoản migrator), `wallet`, `payment`. Thứ tự: hạ tầng khỏe → init → migrate → service. Cả hai nhận `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` và `OTEL_SERVICE_NAME`.
- `deploy/Dockerfile.dev`: image cài dependency sẵn; chỉ `src` được bind-mount (chỉ đọc). Đổi dependency thì `up --build`.
- Cổng mặc định lệch khỏi stack ecommerce để chạy song song (ví dụ SQL 11433, Elasticsearch 19200, Kibana 15601, OTLP 14317), đổi qua `deploy/.env`. `deploy/.env.example` thêm khóa cho mode local với giá trị mẫu chỉ dành cho local.
- `compose.billing.yml` (overlay hạ tầng dùng chung với ecommerce) và `compose.pact-broker.yml` giữ nguyên.
- `corepack pnpm local:seed` (Node, chạy được trên Windows): tạo ví, nạp tiền, gửi vài `OrderReadyForPaymentV1` mô phỏng, chạy một lượt đối soát, để dashboard có số liệu.

## 5. Kiểm thử

- **Unit:** adapter `Metrics` OTel với exporter in-memory (tên, đơn vị, nhãn); `initTelemetry` no-op khi không có endpoint; schema và trộn tham số; bộ sinh `.ndjson` (giống file đã commit, ID ổn định).
- **Integration (testcontainer sẵn có):** `StateSampler` trả đúng gauge trên dữ liệu dựng sẵn, gồm DLQ depth đọc bằng passive declare với quyền thật của user `billing_wallet`; bộ đếm tăng đúng khi `PayOrder` trả `paid` hoặc từ chối và khi consumer retry hoặc đẩy vào DLQ.
- **Kibana thật (`corepack pnpm kibana:verify`, không chạy trong CI):** dựng compose local, `kibana:apply`, `local:seed`, rồi qua API Kibana kiểm tra rule tồn tại, bật, chạy không lỗi; dashboard tồn tại và panel truy vấn ra dữ liệu; đổi một tham số rồi `apply` thì rule đổi theo mà không tạo bản trùng. Kết quả chạy được ghi trong báo cáo thực thi.

## 6. Tài liệu

`docs/ops/kibana-alerts-and-dashboard.vi.md` (bảng mọi tham số: tên, ý nghĩa, mặc định, khoảng hợp lệ; quy trình đổi ngưỡng → dry-run → apply → kiểm tra; xử lý sửa tay trên giao diện; rollback), `docs/ops/local-stack.vi.md` (một lệnh, cổng, mật khẩu mẫu, sự cố thường gặp), ADR-0011 (OTel SDK đẩy OTLP; gauge trạng thái do service tự đo; rule sinh từ code với ID cố định), mục chạy local trong README, và cập nhật `dlq-runbook` và `reconciliation-runbook` trỏ tới tên rule tương ứng.

## 7. Rủi ro đã biết

- Tên trường metric trong Elasticsearch do collector quyết định; xác nhận bằng stack thật trước khi cố định ES|QL, nếu khác dự kiến thì sửa bộ sinh.
- Cấu trúc saved object gắn với Kibana 9.4.4; phiên bản khác có thể từ chối import (tài liệu ghi rõ phiên bản).
- Mỗi pod tự đo gauge nên truy vấn DB lặp theo số pod; chấp nhận được (truy vấn nhẹ, chu kỳ ~15 s, có index sẵn).
- Gauge phụ thuộc DB còn sống; khi DB sập thì metric đó tạm mất, và `billing-service-silent` bắt trường hợp service ngừng gửi metric.
- Image `Dockerfile.dev` chứa dependency Linux cài lúc build; nếu `pnpm-lock.yaml` đổi mà quên `--build` thì container chạy dependency cũ.

## 8. Ngoài phạm vi

Trace và log OTel; SLO và ngân sách lỗi cho billing; connector thông báo; dọn dữ liệu (6b); công cụ vận hành (6c); chaos (6d); tối ưu `MERCHANT` (6e); manifest K8s và Unleash; Dockerfile production.
