# Bước 6a — Metric, cảnh báo và stack local một lệnh: thiết kế

**Ngày:** 2026-10-11
**Trạng thái:** Đã triển khai (nhánh `feature/ops-metrics-alerts`; đã kiểm chứng trên stack Docker thật, `kibana:verify` đạt 27/27). Văn bản dưới đây đã được cập nhật cho khớp với bản dựng; các điểm khác với kế hoạch ban đầu nằm ở mục 9
**Phạm vi:** Metric OpenTelemetry cho wallet và payment (đẩy OTLP), rule cảnh báo và dashboard Kibana có tham số điều chỉnh được, stack local chạy bằng một lệnh `docker compose`. Là vòng đầu của Bước 6 (vận hành); các vòng 6b dọn dữ liệu, 6c công cụ vận hành, 6d chaos, 6e tối ưu `MERCHANT` có spec riêng. Dựa trên spec nền tảng (`2026-10-09-billing-framework-design.md`, mục 6–8) và đối soát (`2026-10-10-reconciliation-design.md`).

## 1. Mục tiêu và quyết định đã chốt

Người vận hành thấy được sức khỏe của billing (hàng đợi chết, outbox, nạp tiền, đối soát) trên Kibana, nhận alert khi vượt ngưỡng, và chỉnh ngưỡng mà không phải sửa code hay import tay.

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Cách xuất metric | OpenTelemetry SDK, đẩy OTLP/gRPC tới collector rồi vào Elasticsearch (đúng spec nền: OTel → Elastic, cùng đường với ecommerce) |
| 2 | Loại tín hiệu | Chỉ **metric**. Trace và log OTel, SLO và ngân sách lỗi cho billing không thuộc 6a |
| 3 | Gauge trạng thái | Do từng service tự đo định kỳ bằng truy vấn nhẹ (DB, broker) trong một `Worker` riêng; mỗi pod báo cùng giá trị, rule lấy giá trị mới nhất (`LAST`) trong cửa sổ, riêng DLQ lấy `MIN` |
| 4 | Cảnh báo | Rule Kibana `.es-query` (ES\|QL) và dashboard Lens ES\|QL, định dạng saved object của Kibana 9.4.4, **sinh từ code** với ID cố định. Cần Kibana/Elasticsearch **từ 9.4** (`MIN_STACK_VERSION`) |
| 5 | Điều chỉnh | Mọi điều kiện là tham số (`params.defaults.json` + `params.local.json` git-ignored); `kibana:apply` cập nhật tại chỗ rule và dashboard đang chạy |
| 6 | Stack local | `deploy/compose.infra.yml` (hạ tầng), `deploy/compose.services.yml` (migrate, wallet, payment, `kibana-import`), `deploy/compose.local.yml` (`include` cả hai); một lệnh `docker compose up` |
| 7 | Service trong container | Một `deploy/Dockerfile.dev` chỉ dùng cho local; chỉ bind-mount các thư mục `src` (chỉ đọc) để `tsx watch` nạp lại, không mount cả repo |
| 8 | Thông báo | Rule chỉ tạo alert trong Kibana. Connector (email, Slack) là hạ tầng của người vận hành, ngoài phạm vi |

## 2. Metric trong code

### 2.1 Cấu trúc

- `packages/observability` thêm `initTelemetry({ serviceName })`: dùng OTel SDK với exporter OTLP/gRPC, đọc `OTEL_EXPORTER_OTLP_ENDPOINT` và `OTEL_SERVICE_NAME`. Khi không đặt endpoint thì **no-op** (test và chạy trần không đổi). Dừng êm khi service tắt (flush).
- Resource attribute gồm `service.name` và `service.instance.id` (mặc định UUID mới mỗi lần khởi động, đặt được bằng `OTEL_SERVICE_INSTANCE_ID`): mỗi tiến trình một chuỗi riêng, nên counter reset sau restart không bị trộn với bản trước.
- `application` chỉ biết port `Metrics` (các hàm đếm sự kiện, `publishState` và `prime`); adapter OTel nằm ở `infrastructure`. `Metrics.prime(tenants)` khởi tạo các chuỗi counter ở 0 (ví dụ lượt đối soát `FAILED`) để lần tăng đầu tiên nhìn thấy được như một mức tăng. `domain` không đổi.
- Bộ đếm ghi ngay tại chỗ sự kiện xảy ra. Gauge do use case `SampleState` của từng service tính định kỳ (mặc định 15 s, cấu hình được) bằng truy vấn nhẹ, chạy trong **`Worker` riêng** để một truy vấn chậm không làm trễ nạp tiền, relay outbox hay đối soát; lỗi khi lấy mẫu chỉ log, không làm hỏng service, và gauge **ngừng báo cáo** thay vì giữ số cũ (wallet bỏ chuỗi của tenant lỗi; payment gọi `publishState(null)`). Gauge được xuất ở chế độ delta nên một tập nhãn không còn được báo (ví dụ loại lệch đối soát đã hết) ngừng xuất hiện thay vì kẹt ở giá trị cũ.
- Cấu hình thêm: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `METRICS_SAMPLE_INTERVAL_SECONDS` (mặc định 15). Vào `.env.example` và được `env-example.test.ts` kiểm.

### 2.2 Danh mục (tiền tố `billing.`, nhãn `tenant` khi có nghĩa)

| Nhóm | Metric | Loại | Nguồn |
|---|---|---|---|
| Order | `order_payments` theo `outcome` (`paid`, `failed:<reason>`, `replayed`) | counter | `PayOrder` |
| Consumer | `consumer.messages` theo `result` (`processed`, `retried`, `dead_lettered`, `rejected`) | counter | `packages/messaging` consumer |
| DLQ | `dlq.depth` (queue `wallet.order-payments.dlq`) | gauge | passive declare AMQP (không cần quyền management) |
| Outbox | `outbox.pending`, `outbox.oldest_age_seconds` | gauge | truy vấn bảng `outbox` mỗi tenant |
| Nạp tiền | `topups` theo `stage` (`submit`, `webhook`, `reconciliation`) và `outcome`; `topups.requested_backlog`, `topups.oldest_requested_age_seconds` | counter, gauge | `ApplyPaymentResult`, `SubmitTopup`; truy vấn `topups` |
| Đối soát | `reconciliation.runs` theo `status`; `reconciliation.open_items` theo `kind`; `reconciliation.oldest_open_item_age_seconds`; `reconciliation.last_success_age_seconds` | counter, gauge | `RunReconciliation`; truy vấn `reconciliation_*` |
| Payment | `payment.charges` theo `status`; `payment.webhook_deliveries` theo `result` (`delivered`, `retrying`, `failed`); `payment.webhook_backlog`, `payment.webhook_oldest_age_seconds` | counter, gauge | use case payment; truy vấn payment |

Chi tiết nhãn:

- `topups`: `stage=submit` có `outcome` ∈ `submitted | rejected | retry_scheduled | failed | superseded`; `stage=webhook` và `stage=reconciliation` có `outcome` ∈ `succeeded | failed | duplicate | ignored | mismatch | unknown_topup`. `ApplyPaymentResult` nhận thêm `source` tùy chọn (mặc định `webhook`; đối soát truyền `reconciliation`) để các lần tự ghi bù không bị đếm là webhook.
- `reconciliation.last_success_age_seconds` tính từ lượt `COMPLETED` gần nhất của bất kỳ `triggered_by` nào; bỏ qua với tenant chưa từng hoàn tất lượt nào. Truy vấn mục mở dựa vào index mới `ix_reconciliation_items_open (case_status, kind) include (created_at)` do migration tenant `005-reconciliation-open-index` thêm.
- `payment.webhook_failures` trong bản nháp đầu được thay bằng `payment.webhook_deliveries` (cảnh báo dùng `result = failed`).
- Metric chỉ xuất hiện khi có sự kiện hoặc có dữ liệu: `topups`, `payment.charges`, `payment.webhook_deliveries` và `reconciliation.open_items` (chưa có ca mở thì không có chuỗi nào).

Tên trường trong Elasticsearch đã được xác nhận trên stack thật (collector `mode: otel`): `metrics.billing.*`, `attributes.<nhãn>`, `resource.attributes.service.name`, `resource.attributes.service.instance.id`, mọi thứ đi qua một nơi duy nhất `tools/kibana/fields.ts`; xem [`docs/ops/metric-fields.md`](../../ops/metric-fields.md).

## 3. Rule cảnh báo và dashboard

### 3.1 Sinh từ code

Bộ sinh nằm ở `tools/kibana/` (`params.ts` kiểm tra và trộn tham số, `fields.ts` ánh xạ tên trường, `rules.ts` và `dashboard.ts` dựng rule và panel, `ids.ts` tạo ID cố định). `kibana:build -- --defaults-only` sinh `deploy/kibana/billing-alerts.ndjson` và `billing-dashboard.ndjson` (commit, ứng với tham số mặc định). Test kiểm tra sinh lại thì giống file đã commit và ID ổn định giữa các lần sinh. Mọi câu ES|QL bắt đầu bằng `SET unmapped_fields="nullify";` (metric chưa có dữ liệu thành null thay vì lỗi `Unknown column`) và dùng `LAST(field, @timestamp)` cho giá trị hiện tại; vì vậy stack tối thiểu là 9.4 (`MIN_STACK_VERSION` trong `rules.ts`, `kibana:apply`/`verify` từ chối stack cũ hơn). Cấu trúc saved object lấy từ các file export của Kibana 9.4.4 bên ecommerce (`docs/kibana-quan-sat-he-thong`).

### 3.2 Rule (mỗi rule gắn tag `billing`; mô tả nêu runbook cần mở)

| Rule | Điều kiện (mặc định) | Mức độ | Runbook |
|---|---|---|---|
| `billing-dlq-not-empty` | `dlq.depth` > 0 liên tục 5 phút | critical | `dlq-runbook` |
| `billing-outbox-stuck` | `outbox.oldest_age_seconds` > 300 | high | `orders-handoff` |
| `billing-topups-stuck` | `topups.oldest_requested_age_seconds` > 300 | high | README wallet |
| `billing-ledger-integrity` | `open_items` loại `LEDGER_UNBALANCED` hoặc `BALANCE_MISMATCH` > 0 | critical | `reconciliation-runbook` |
| `billing-reconciliation-stale-cases` | mục `OPEN` có tuổi > 24 giờ | warning | `reconciliation-runbook` |
| `billing-reconciliation-missed` | `last_success_age_seconds` > 26 giờ | high | `reconciliation-runbook` |
| `billing-reconciliation-failed-run` | có lượt `FAILED` mới trong cửa sổ (tổng mức tăng của `reconciliation.runs{status=FAILED}` ở mọi tiến trình > 0) | high | `reconciliation-runbook` |
| `billing-service-silent` | wallet hoặc payment đã gửi gauge trạng thái trong `lookbackHours` (6) giờ qua nhưng im quá 5 phút | high | README |

Ghi chú: rule `billing-reconciliation-failed-run` tách khỏi `missed` (bản nháp gộp hai điều kiện). Nó dùng hai bước `STATS` (mức tăng `MAX - MIN` trong cửa sổ theo từng `service.instance.id`, rồi cộng theo tenant) nên counter reset khi restart không gây báo nhầm. **Danh tính alert:** `KEEP` cuối của mỗi rule chỉ chứa cột định danh (`RuleDefinition.identityColumns`: `queue`, `tenant`, `tenant, kind` hoặc `service`), vì Kibana 9.4 dựng id instance từ mọi cột đầu ra; cột giá trị làm mỗi lần chạy sinh alert mới và đóng alert cũ (đã quan sát trên stack thật). `billing-service-silent` chỉ xét tài liệu có gauge trạng thái (`billing.outbox.pending` hoặc `billing.payment.webhook_backlog`) nên chỉ bị im khi service không lấy mẫu được hoặc không gửi gì; nó tự hết báo sau `lookbackHours` giờ im lặng và không bao giờ báo cho service chưa từng gửi gauge (danh sách `wallet`, `payment` nằm trong câu ES|QL); riêng rule này cửa sổ của Kibana là `lookbackHours * 60` phút. Rule dùng `LAST` có thể còn active tối đa một cửa sổ sau khi một chuỗi ngừng được báo.

### 3.3 Dashboard "Billing: vận hành"

Một dashboard (10 panel dữ liệu và một ô giới thiệu, ES|QL): bảng alert đang bật của các rule `billing`; DLQ depth; tuổi cái cũ nhất của outbox theo tenant kèm đường ngưỡng; thanh toán order theo `tenant / outcome` (tích lũy); message consumer theo kết quả (tích lũy); backlog nạp tiền và tuổi lâu nhất kèm đường ngưỡng; charge payment theo trạng thái và webhook theo kết quả (một biểu đồ, tích lũy); backlog webhook payment; bảng mục lệch đối soát mở theo tenant và loại; bảng độ tươi của đối soát (lần thành công gần nhất và mục mở cũ nhất theo tenant, kèm ngưỡng của hai rule). Đường ngưỡng lấy cùng tham số với rule tương ứng.

- Ba panel dạng bảng là **saved search ES|QL tham chiếu từ dashboard** (by-reference), import cùng dashboard (5 object: data view, 3 saved search, dashboard).
- Counter gộp bằng `MAX` trong mỗi bucket 1 phút, không cộng các bản sao; gauge theo phút lấy `MAX`, bảng lấy `LAST`.
- **Tiêu đề panel hiện bằng tiếng Anh** (ví dụ "DLQ depth", "Active billing alerts"), trong khi ô giới thiệu, mô tả và tài liệu là tiếng Việt. Việt hóa tiêu đề là việc tiếp theo đã biết, chưa làm.

### 3.4 Tham số và áp dụng lên Kibana đang chạy

- `deploy/kibana/params.defaults.json` (commit) chứa mọi mặc định; `params.local.json` (git-ignored) chỉ ghi các khóa muốn đổi. Mỗi rule có `enabled`, ngưỡng riêng, `windowMinutes`, `intervalMinutes`, `severity`; dashboard có `timeRange`. Có schema kiểm tra (sai kiểu, âm, ngoài khoảng bị từ chối kèm thông báo rõ trước khi gọi Kibana).
- `corepack pnpm kibana:apply [-- --dry-run]`: kiểm tra phiên bản stack (>= `MIN_STACK_VERSION`), trộn tham số, sinh đối tượng, rồi **cập nhật tại chỗ** nhờ ID cố định. Rule: tạo nếu chưa có, ngược lại `PUT /api/alerting/rule/{id}` (giữ lịch sử alert) và `_enable`/`_disable` theo `enabled` của tham số (mặc định `true`: rule tắt tay trên giao diện sẽ được bật lại). Dashboard, saved search và data view: import với `overwrite=true`. `--dry-run` chỉ đọc, in khác biệt của từng rule. `apply` **không bao giờ xóa rule**; rule có tag `billing` mà công cụ không quản lý chỉ được báo. `actions` (connector) gắn tay được giữ nguyên qua các lần `apply` (đọc từ Kibana và gửi lại; không bao giờ thêm hay gỡ).
- Đích lấy từ `KIBANA_URL` hoặc `--kibana-url` (mặc định theo cổng compose local `http://localhost:15601`); cùng lệnh dùng cho Kibana khác.
- `corepack pnpm kibana:build -- --out <thư mục>` xuất hai file `.ndjson` từ tham số hiện tại để import tay (Saved Objects → Import; rule vào ở trạng thái tắt và phải bật tay). Không có `--out`, lệnh ghi đè `deploy/kibana/*.ndjson` kể cả bằng `params.local.json`; chỉ tái tạo file commit bằng `--defaults-only`.
- `corepack pnpm kibana:verify [-- --expect-alert <rule>]`: kiểm tra rule tồn tại và bật đúng, lần chạy gần nhất không lỗi, dashboard tồn tại, mọi câu ES|QL của rule và panel chạy được trên Elasticsearch, và (tùy chọn) có alert active.
- Rule do ai đó sửa trực tiếp trên giao diện bị `apply` lần sau ghi đè về tham số; `--dry-run` cho thấy khác biệt đó. Rollback: xóa khóa trong `params.local.json` rồi `apply`.

## 4. Stack local một lệnh

```bash
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
```

- `compose.infra.yml`: SQL Server 2022, RabbitMQ (management), Elasticsearch 9.4.4 và Kibana 9.4.4 (một node, tắt security, `XPACK_ENCRYPTEDSAVEDOBJECTS_ENCRYPTIONKEY` đặt sẵn vì Alerting cần), OTel Collector contrib 0.160.0 (OTLP → Elasticsearch `mode: otel` + exporter `debug`; cấu hình `deploy/otel/collector-config.yaml`), job khởi tạo DB và RabbitMQ (dùng lại `sql/init.sql` và `scripts/init-rabbitmq.sh`).
- `compose.services.yml`: job `migrate` (wallet, payment bằng tài khoản migrator), `wallet`, `payment`, và job `kibana-import` (chờ Kibana khỏe rồi chạy `kibana:apply`; rule được tạo ở trạng thái bật hay tắt theo tham số `enabled`). `kibana-import` nằm ở file này vì cần image dev (`billing-dev:local`) có sẵn `tools/kibana`; `deploy/kibana` được mount vào đó để nhận `params.local.json`. Thứ tự: hạ tầng khỏe → init → migrate → service. Cả hai service nhận `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` và `OTEL_SERVICE_NAME`.
- `deploy/Dockerfile.dev`: image cài dependency sẵn; chỉ `src` được bind-mount (chỉ đọc). Đổi dependency thì `up --build`.
- Cổng mặc định lệch khỏi stack ecommerce để chạy song song (ví dụ SQL 11433, Elasticsearch 19200, Kibana 15601, OTLP 14317), đổi qua `deploy/.env`. `deploy/.env.example` thêm khóa cho mode local với giá trị mẫu chỉ dành cho local.
- `compose.billing.yml` (overlay hạ tầng dùng chung với ecommerce) và `compose.pact-broker.yml` giữ nguyên.
- `corepack pnpm local:seed [-- --with-dlq]` (Node, chạy được trên Windows): tạo ví `seed-1..3` cho mỗi tenant, nạp tiền một lần (khóa idempotency cố định), gửi 3 `OrderReadyForPaymentV1` mỗi tenant (đơn thứ ba cố ý vượt số dư), chạy một lượt đối soát; `--with-dlq` thêm một message hỏng vào DLQ. Hệ quả đã biết: không có consumer của ecommerce nên `billing.events` không có queue, dòng outbox ở lại `pending` và `billing-outbox-stuck` báo cho tới khi tạo queue hứng; DLQ giữ message tới khi purge; chạy lại nhiều lần thì đơn dần bị `INSUFFICIENT_FUNDS`. Cách xử lý ghi ở `docs/ops/local-stack.vi.md`.

## 5. Kiểm thử

- **Unit:** adapter `Metrics` OTel với exporter in-memory (tên, đơn vị, nhãn); `initTelemetry` no-op khi không có endpoint; schema và trộn tham số; bộ sinh `.ndjson` (giống file đã commit, ID ổn định).
- **Integration (testcontainer sẵn có):** `SampleState` trả đúng gauge trên dữ liệu dựng sẵn, gồm DLQ depth đọc bằng passive declare với quyền thật của user `billing_wallet`; bộ đếm tăng đúng khi `PayOrder` trả `paid` hoặc từ chối và khi consumer retry hoặc đẩy vào DLQ.
- **Kibana thật (`corepack pnpm kibana:verify`, không chạy trong CI):** dựng compose local, `kibana:apply`, `local:seed`, rồi qua API Kibana kiểm tra rule tồn tại, bật, chạy không lỗi; dashboard tồn tại và panel truy vấn ra dữ liệu; đổi một tham số rồi `apply` thì rule đổi theo mà không tạo bản trùng. Kết quả chạy được ghi trong báo cáo thực thi.

Kết quả chạy thật: `kibana:verify` thoát 0 với 27 dòng PASS (8 rule, dashboard, 10 câu panel, 8 câu rule), alert `billing-dlq-not-empty` active sau `local:seed -- --with-dlq`, và đổi `thresholdSeconds` của `billing-outbox-stuck` 300 → 1 → 300 qua `apply` đổi đúng một rule mà không tạo bản trùng.

## 6. Tài liệu

`docs/ops/kibana-alerts-and-dashboard.vi.md` (bảng mọi tham số: tên, ý nghĩa, mặc định, khoảng hợp lệ; quy trình đổi ngưỡng → dry-run → apply → kiểm tra; xử lý sửa tay trên giao diện; rollback), `docs/ops/local-stack.vi.md` (một lệnh, cổng, mật khẩu mẫu, sự cố thường gặp), ADR-0011 (OTel SDK đẩy OTLP; gauge trạng thái do service tự đo; rule sinh từ code với ID cố định), mục chạy local trong README, và cập nhật `dlq-runbook` và `reconciliation-runbook` trỏ tới tên rule tương ứng.

## 7. Rủi ro đã biết (xem thêm mục 9)

- Tên trường metric trong Elasticsearch do collector quyết định; xác nhận bằng stack thật trước khi cố định ES|QL, nếu khác dự kiến thì sửa bộ sinh.
- Cấu trúc saved object gắn với Kibana 9.4.4; phiên bản khác có thể từ chối import (tài liệu ghi rõ phiên bản).
- Mỗi pod tự đo gauge nên truy vấn DB lặp theo số pod; chấp nhận được (truy vấn nhẹ, chu kỳ ~15 s, có index sẵn).
- Gauge phụ thuộc DB còn sống. Khi lấy mẫu lỗi, gauge **ngừng báo cáo**: payment không xuất gauge nào (`publishState(null)`), wallet bỏ chuỗi của tenant lỗi (tất cả tenant lỗi thì không còn chuỗi nào). Vì `billing-service-silent` chỉ xét tài liệu có gauge trạng thái, "service sống nhưng không lấy mẫu được" báo trong `silentMinutes`; các rule gauge khác (outbox, nạp tiền, đối soát) tự hết báo vì không còn điểm dữ liệu, nên khi một tenant lỗi mà tenant khác vẫn đo được thì chỉ có chuỗi của tenant lỗi mất đi.
- Image `Dockerfile.dev` chứa dependency Linux cài lúc build; nếu `pnpm-lock.yaml` đổi mà quên `--build` thì container chạy dependency cũ.

## 8. Ngoài phạm vi

Trace và log OTel; SLO và ngân sách lỗi cho billing; connector thông báo; dọn dữ liệu (6b); công cụ vận hành (6c); chaos (6d); tối ưu `MERCHANT` (6e); manifest K8s và Unleash; Dockerfile production.

## 9. Điểm khác bản nháp ban đầu (đã chốt khi lập kế hoạch và review)

Làm rõ khi lập kế hoạch:

1. `payment.webhook_failures` thành `billing.payment.webhook_deliveries` với `result` ∈ `delivered | retrying | failed`.
2. `billing.topups` mang `stage` ∈ `submit | webhook | reconciliation` và `outcome`; `ApplyPaymentResult` nhận `source` tùy chọn.
3. `billing.reconciliation.last_success_age_seconds` tính từ lượt `COMPLETED` gần nhất của mọi `triggered_by`; không có chuỗi cho tenant chưa từng hoàn tất.
4. Migration tenant mới `005-reconciliation-open-index` thêm `ix_reconciliation_items_open (case_status, kind) include (created_at)`.
5. Lấy mẫu trạng thái chạy trong `Worker` riêng (`METRICS_SAMPLE_INTERVAL_SECONDS`, mặc định 15).
6. Rule tạo qua Alerting API bật/tắt theo `enabled`; file `.ndjson` (import tay) mang rule ở trạng thái tắt và tài liệu dặn bật sau khi import.
7. Tên trường trong Elasticsearch được xác nhận trên stack thật và ghi ở `tools/kibana/fields.ts` (một nơi duy nhất).

Chốt khi review và dựng:

- Resource attribute `service.instance.id` (mỗi tiến trình một chuỗi) và truy vấn hai bước cho `billing-reconciliation-failed-run`, để counter reset khi restart không gây báo nhầm; `billing-reconciliation-failed-run` là rule thứ tám, tách khỏi `billing-reconciliation-missed`.
- `MIN_STACK_VERSION = 9.4.0` và `SET unmapped_fields="nullify";` ở đầu mọi câu ES|QL; `kibana:apply` và `kibana:verify` từ chối stack cũ hơn.
- `LAST(field, @timestamp)` cho giá trị hiện tại (DLQ dùng `MIN` trên cửa sổ); hệ quả: rule có thể còn active tối đa một cửa sổ sau khi chuỗi ngừng được báo.
- Dashboard dùng saved search by-reference cho ba panel bảng; counter gộp bằng `MAX` mỗi bucket; **tiêu đề panel hiện vẫn bằng tiếng Anh** (việc tiếp theo đã biết).
- `Metrics.prime`; `kibana-import` thuộc `compose.services.yml` (cần image dev); bộ lấy mẫu trong `Worker` riêng.
- Thêm `corepack pnpm kibana:verify` và `corepack pnpm local:seed` (mục 4 và 5); `apply` không bao giờ xóa rule và không quản lý `actions`.
