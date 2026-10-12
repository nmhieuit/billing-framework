# Stack local một lệnh

Chạy toàn bộ billing trên máy (SQL Server, RabbitMQ, Elasticsearch, Kibana, OTel Collector, wallet, payment) để xem metric,
cảnh báo và dashboard thật. Stack này **độc lập với stack ecommerce** (project compose riêng `billing-local`, network riêng) và
chỉ dùng giá trị mẫu dành cho local. Cảnh báo/dashboard: [kibana-alerts-and-dashboard](kibana-alerts-and-dashboard.vi.md); quyết
định: [ADR-0011](../adr/0011-otel-metrics-and-generated-kibana-rules.vi.md).

## Một lệnh

```bash
cp deploy/.env.example deploy/.env      # lần đầu; rồi điền các giá trị bên dưới
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
```

`compose.local.yml` chỉ `include` hai file: `compose.infra.yml` (hạ tầng và job khởi tạo) và `compose.services.yml` (migrate,
wallet, payment, `kibana-import`). `compose.billing.yml` (overlay cho hạ tầng dùng chung với ecommerce) và
`compose.pact-broker.yml` không liên quan tới stack này.

### Điền `deploy/.env`

Mọi giá trị là mẫu cục bộ, không dùng lại cho môi trường thật; **không commit** `deploy/.env` (git-ignored).

| Khóa                                                                                                        | Điền gì                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `BILLING_SQLSERVER_SA_PASSWORD`                                                                             | Mật khẩu `sa`, **đủ mạnh theo chính sách SQL Server** (tối thiểu 8 ký tự, 3 trong 4 loại: hoa, thường, số, ký hiệu) |
| `BILLING_WALLET_DB_PASSWORD`, `BILLING_PAYMENT_DB_PASSWORD`                                                 | Mật khẩu hai tài khoản ứng dụng (cũng phải đạt chính sách SQL Server)                       |
| `BILLING_WALLET_MIGRATOR_DB_PASSWORD`, `BILLING_PAYMENT_MIGRATOR_DB_PASSWORD`                              | Mật khẩu hai tài khoản chạy migration                                                       |
| `BILLING_RABBITMQ_ADMIN_USER`, `BILLING_RABBITMQ_ADMIN_PASSWORD`                                            | Tài khoản quản trị RabbitMQ (đăng nhập giao diện management)                                |
| `BILLING_WALLET_MQ_PASSWORD`, `BILLING_PAYMENT_MQ_PASSWORD`, `BILLING_ECOMMERCE_MQ_PASSWORD`               | Mật khẩu user RabbitMQ; chỉ gồm chữ, số, `-`, `_`                                          |
| `KIBANA_ENCRYPTION_KEY`                                                                                     | Khóa mã hóa saved object của Alerting, **tối thiểu 32 ký tự** (đã có mẫu)                  |
| `LOCAL_WEBHOOK_SECRET`                                                                                      | Bí mật chữ ký webhook payment tới wallet (đã có mẫu)                                        |
| `LOCAL_TENANTS`                                                                                             | Danh sách tenant, mặc định `acme,beta`                                                      |

Khóa `BILLING_SQLSERVER_HOST`, `BILLING_RABBITMQ_HOST`, `ECOMMERCE_NETWORK`... trong cùng file là cho stack dùng chung với
ecommerce (`compose.billing.yml`), stack local không dùng. Thiếu một biến bắt buộc thì `docker compose` dừng ngay với thông
báo `set in deploy/.env`.

## Dịch vụ và cổng

Cổng ở cột "Mặc định" là cổng trên máy chủ; đổi bằng biến trong `deploy/.env`.

**Stack chỉ lắng nghe trên loopback (`127.0.0.1`).** Elasticsearch, Kibana, RabbitMQ (kể cả management), SQL Server, collector, wallet và
payment đều không có xác thực (hoặc dùng tài khoản mặc định của môi trường dev), nên mọi cổng được publish dưới dạng
`127.0.0.1:<cổng>:<cổng container>`: máy khác trong cùng LAN/Wi-Fi không truy cập được. Muốn mở có chủ đích, sửa tiền tố
`127.0.0.1:` của cổng tương ứng trong `deploy/compose.infra.yml` / `compose.services.yml` (ví dụ bỏ hẳn tiền tố để lắng nghe
trên mọi giao diện) và chỉ làm vậy trên mạng tin cậy. Các service giao tiếp với nhau qua mạng compose nên không bị ảnh hưởng.

| Dịch vụ                              | Mặc định | Biến đổi cổng                | Ghi chú                                                         |
| ------------------------------------ | -------- | ---------------------------- | --------------------------------------------------------------- |
| wallet                               | 3001     | `LOCAL_WALLET_PORT`          | `http://localhost:3001/health`                                  |
| payment                              | 3002     | `LOCAL_PAYMENT_PORT`         | `http://localhost:3002/health`                                  |
| SQL Server                           | 11433    | `LOCAL_SQL_PORT`             | user `sa`; DB `billing_wallet`, `billing_payment`               |
| RabbitMQ AMQP                        | 15673    | `LOCAL_AMQP_PORT`            | vhost `billing`                                                 |
| RabbitMQ management                  | 15674    | `LOCAL_RABBITMQ_MGMT_PORT`   | `http://localhost:15674`, đăng nhập bằng tài khoản quản trị     |
| Elasticsearch                        | 19200    | `LOCAL_ELASTICSEARCH_PORT`   | một node, tắt security; `ELASTICSEARCH_JAVA_OPTS` chỉnh heap (mặc định `-Xms512m -Xmx512m`) |
| Kibana                               | 15601    | `LOCAL_KIBANA_PORT`          | `http://localhost:15601`                                        |
| OTel Collector (OTLP gRPC)           | 14317    | `LOCAL_OTLP_GRPC_PORT`       | wallet/payment trong compose gửi tới `http://otel-collector:4317` |

Các job chạy một lần rồi thoát với mã 0: `billing-sql-init` (tạo DB, login), `billing-rabbitmq-init` (vhost, user, exchange),
`migrate` (migration wallet theo từng tenant và payment), `kibana-import` (chạy `kibana:apply`).

## Lần chạy đầu và cách kiểm tra

Thứ tự: SQL Server, RabbitMQ, Elasticsearch khỏe, rồi `billing-sql-init`, `billing-rabbitmq-init`, Kibana, rồi `migrate`, rồi
wallet và payment (chờ cả collector), và `kibana-import` chờ Kibana khỏe. Lần đầu có thể mất nhiều phút (xem phần sự cố).

```bash
docker compose -f deploy/compose.local.yml --env-file deploy/.env ps -a
curl -s http://localhost:3001/health        # {"status":"ok","service":"wallet"}
curl -s http://localhost:3002/health        # {"status":"ok","service":"payment"}
curl -s http://localhost:19200/_cluster/health   # "yellow" là bình thường (một node, không có replica)
```

Đạt khi: `elasticsearch`, `kibana`, `rabbitmq`, `sqlserver` ở trạng thái healthy; `wallet`, `payment`, `otel-collector` Up;
bốn job trên `Exited (0)`. Rồi mở Kibana tại `http://localhost:15601`: Rules (tag `billing`, 9 rule) và dashboard
"Billing: vận hành". Xem log job: `docker compose ... logs kibana-import`. Kiểm tra tự động toàn bộ:

```bash
corepack pnpm kibana:verify                                  # rule, dashboard, mọi câu ES|QL; thoát 0 khi PASS hết
corepack pnpm kibana:verify -- --expect-alert billing-dlq-not-empty --timeout-seconds 600   # chờ thêm một alert active
```

`kibana:verify` đọc `KIBANA_URL` (mặc định `http://localhost:15601`) và `ELASTICSEARCH_URL` (mặc định `http://localhost:19200`),
hoặc cờ `--kibana-url`, `--elasticsearch-url`.

## Nạp dữ liệu mẫu

```bash
corepack pnpm local:seed                 # thêm `-- --with-dlq` để đẩy một message hỏng vào DLQ
```

Seed (chạy trên máy chủ, cần stack đang chạy; đọc `BILLING_ECOMMERCE_MQ_PASSWORD` và `LOCAL_*` từ môi trường hoặc `deploy/.env`):
tạo ví `seed-1..3` cho mỗi tenant, nạp 500.000 VND mỗi ví, publish 3 đơn mỗi tenant tới `orders.events` (10.000, 20.000 và
10.000.000 VND; đơn cuối bị từ chối `INSUFFICIENT_FUNDS` có chủ ý), chạy đối soát ngày hôm nay và chờ `COMPLETED`; với
`--with-dlq` thêm một message không đọc được vào `wallet.order-payments.dlq`. Địa chỉ wallet mặc định `http://localhost:3001`
(đổi bằng biến `WALLET_URL`). Sau khoảng một đến hai phút (chu kỳ lấy mẫu 15 giây và xuất 10 giây) dashboard có số liệu.

Hai điều cần biết khi chạy seed trên stack này:

- **Nạp tiền chỉ một lần cho mỗi ví** (khóa idempotency cố định `seed-topup-<tenant>-<khách>`), còn mỗi lần chạy lại trừ thêm tiền
  bằng đơn mới. Chạy lại nhiều lần thì các đơn sau dần bị từ chối `INSUFFICIENT_FUNDS`. Muốn số dư mới: `down -v` (xem dưới).
- Seed tạo queue hứng `ecommerce.billing-events` (bền, gắn vào `billing.events` với routing key `#`) để đóng vai consumer của ecommerce, nên outbox của seed được giao đi và `billing-outbox-stuck` không báo. Muốn demo cảnh báo này: xóa queue đó (xem "Tạo queue hứng" dưới) trước khi seed, hoặc xóa rồi seed lại; queue sẽ được tạo lại ở lần seed sau.

## Công cụ vận hành (ops)

Wallet có API `/ops/...` (đóng/mở băng ví, điều chỉnh, đảo giao dịch, phát lại `OrderPaidV1`). Trên stack local không có gateway nên
bạn tự đặt các header mà gateway thật sẽ đặt (`x-actor-id`, `x-actor-role: OPS`); gateway thật phải xóa `x-actor-*` do client gửi.
Ví dụ với ví `seed-1` của tenant `acme` (sau `local:seed`):

```bash
H='-H x-tenant-id:acme -H x-actor-id:dev -H x-actor-role:OPS -H content-type:application/json'
curl -s -X POST localhost:3001/ops/wallets/seed-1/freeze $H -d '{"reason":"thử nghiệm local","idempotencyKey":"local-freeze-1"}'
curl -s "localhost:3001/ops/actions?limit=5" $H
```

Hướng dẫn đầy đủ: [ops-tools](ops-tools.vi.md).

## Dọn dữ liệu (retention)

Wallet và payment trong stack này chạy job retention ở **chế độ chạy thử**: `deploy/compose.services.yml` đặt
`RETENTION_DRY_RUN: 'true'` rõ ràng cho cả hai service (các biến `RETENTION_*` khác lấy mặc định: bật, 60 phút một lượt). Lượt đầu
chạy ngay khi service khởi động; chạy thử chỉ đếm và log, **không xóa gì**. Chi tiết chính sách, số ngày và quy trình:
[retention](retention.vi.md).

Cách đọc kết quả:

- **Gauge**: sau lượt đầu, `billing.retention.last_success_timestamp_seconds` xuất hiện (panel "Retention: số giây từ lần chạy thành
  công gần nhất" trên dashboard), kể cả khi chưa có dòng nào đủ điều kiện.
- **Counter**: `billing.retention.rows` với `mode = would_delete` chỉ tăng khi có dòng cũ hơn ngưỡng; dữ liệu mới dựng/seed trên stack
  này trẻ hơn mọi ngưỡng (nhỏ nhất 1 ngày) nên thường **không có dòng nào** và panel "Retention: số dòng đã xoá / sẽ xoá" để trống.
- **Log**: `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet payment` tìm `retention run finished` (chỉ
  được log khi có dòng hoặc có lỗi) và `retention policy failed`.

Để chuyển sang xóa thật trên máy local (chỉ dữ liệu thử, vẫn **không hoàn tác**), đổi `RETENTION_DRY_RUN: 'true'` thành `'false'`
trong mục `environment` của `wallet` và/hoặc `payment` ở `deploy/compose.services.yml` rồi
`docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d wallet payment`; nhớ trả lại `'true'` trước khi commit.
Muốn thấy dòng bị dọn, hạ số ngày (ví dụ `RETENTION_OUTBOX_SENT_DAYS: '1'`) trên dữ liệu đủ cũ, hoặc dùng môi trường thử có dữ liệu
lâu năm. Rule `billing-retention-stalled` chạy mỗi 15 phút và chỉ nổ khi lượt thành công gần nhất cũ hơn 3 giờ (mặc định), nên
trên stack khỏe nó không báo.

## Hot reload: đổi code có cần `--build` không

- wallet và payment chạy bằng `tsx watch`. Compose bind-mount **chỉ đọc** các thư mục `src` của `services/wallet`,
  `services/payment` và các package `contracts`, `database`, `messaging`, `money`, `observability`, `runtime`: sửa code ở các thư
  mục này trên máy chủ thì service tự nạp lại, không cần build.
- Cần `up -d --build` khi đổi `package.json`, `pnpm-lock.yaml`, cấu hình `tsconfig` hoặc thêm package mới (image
  `billing-dev:local` cài dependency Linux lúc build; quên `--build` thì container chạy dependency cũ).
- Migration nằm trong `src` nhưng chỉ chạy bởi job `migrate` lúc khởi động: thêm migration thì chạy lại job bằng
  `docker compose -f deploy/compose.local.yml --env-file deploy/.env run --rm migrate` (job bind-mount cùng các thư mục `src` và
  thư mục `db` chỉ đọc nên luôn chạy mã hiện tại) rồi khởi động lại wallet/payment.
- Thư mục `deploy/kibana` được mount vào `kibana-import`, nên đổi `params.local.json` rồi chạy lại job
  (`... run --rm kibana-import`) hoặc, đơn giản hơn, chạy trên máy chủ `corepack pnpm kibana:apply`. Thư mục `tools` cũng được mount
  chỉ đọc, nên job luôn chạy generator ở bản hiện tại (không cần `--build`). Lưu ý: `kibana-import` **bật lại** rule bạn tắt tay;
  muốn tắt bền vững hãy đặt `"enabled": false` trong `params.local.json`. `kibana:apply` chưa hỗ trợ xác thực (chỉ dùng được với Kibana không bật
  bảo mật như stack local).

## Chạy cạnh stack ecommerce

Cổng hạ tầng đã lệch khỏi cổng mặc định của stack ecommerce (SQL 11433, AMQP 15673, management 15674, Elasticsearch 19200,
Kibana 15601, OTLP 14317), project compose (`billing-local`) và network cũng riêng, nên hai stack chạy song song được. Riêng
wallet `3001` và payment `3002` **không** lệch: nếu cổng đó bị chiếm thì đổi `LOCAL_WALLET_PORT` / `LOCAL_PAYMENT_PORT` trong
`deploy/.env`, và đặt `WALLET_URL` cho `local:seed` tương ứng. Khi đổi `LOCAL_AMQP_PORT`, seed tự đọc giá trị mới từ
`deploy/.env`; khi đổi `LOCAL_KIBANA_PORT` / `LOCAL_ELASTICSEARCH_PORT`, đặt `KIBANA_URL` / `ELASTICSEARCH_URL` hoặc dùng cờ.

## Dừng và xóa

```bash
docker compose -f deploy/compose.local.yml --env-file deploy/.env down        # dừng, GIỮ dữ liệu (volume)
docker compose -f deploy/compose.local.yml --env-file deploy/.env down -v     # dừng và XÓA mọi dữ liệu
```

`down` giữ ba volume `sqlserver-data`, `rabbitmq-data`, `elasticsearch-data` (DB, hàng đợi, metric và rule còn nguyên). `down -v`
xóa sạch: lần `up` sau dựng lại từ đầu (DB, user, exchange, rule và dashboard được tạo lại; seed cần chạy lại). Cần dùng `down -v`
khi đổi mật khẩu `sa` hoặc bất kỳ mật khẩu nào đã được áp lúc khởi tạo volume.

## Sự cố thường gặp

| Triệu chứng                                                     | Nguyên nhân                                                                                                                      | Cách xử lý                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` dừng với `set in deploy/.env` hoặc `copy deploy/.env.example`  | Thiếu biến bắt buộc trong `deploy/.env`                                                                       | Điền đủ các khóa ở bảng trên                                                                                                                |
| Job `kibana-import` thoát khác 0 (lỗi kết nối hoặc hết thời gian chờ) | Kibana chưa sẵn sàng: `apply` chờ tối đa 120 giây (Kibana ở trạng thái `degraded` vẫn bị tính là chưa sẵn sàng)             | Đợi `kibana` healthy (`ps -a`), rồi `docker compose ... up -d kibana-import` hoặc `corepack pnpm kibana:apply` từ máy chủ; xem `logs kibana-import` |
| Rule Alerting báo thiếu khóa mã hóa / Kibana không tạo được rule | `KIBANA_ENCRYPTION_KEY` trống hoặc ngắn hơn 32 ký tự                                                                              | Đặt khóa dài ít nhất 32 ký tự rồi `up -d` lại; nếu đã đổi khóa sau khi có rule, rule cũ không giải mã được: xóa rule rồi `kibana:apply`, hoặc `down -v` |
| Container `sqlserver` thoát / `billing-sql-init` lỗi đăng nhập  | Mật khẩu `sa` không đạt chính sách SQL Server, hoặc volume cũ vẫn giữ mật khẩu `sa` ở lần khởi tạo trước                          | Đặt mật khẩu đủ mạnh; nếu volume đã tồn tại với mật khẩu khác thì `down -v` rồi `up` lại                                                    |
| `port is already allocated` / `address already in use`           | Cổng máy chủ bị tiến trình khác (thường là stack ecommerce) chiếm                                                                 | Đổi biến `LOCAL_*_PORT` tương ứng trong `deploy/.env`, `up -d` lại, và đặt `WALLET_URL` / `KIBANA_URL` / `ELASTICSEARCH_URL` khớp           |
| Rule ở trạng thái `pending` mãi (hoặc `kibana:verify` in `not run yet`) | Rule vừa tạo chưa tới lượt chạy đầu; các rule đối soát chạy mỗi 5 hoặc 15 phút                                           | Đợi một chu kỳ (`intervalMinutes`); nếu vẫn `pending`, xem `docker compose ... logs kibana` và `kibana:verify`                              |
| Dashboard/Kibana không có metric                                | Collector không nhận hoặc không ghi được; hoặc service chưa bật xuất metric                                                       | Kiểm tra đáng tin cậy nhất: `curl -s "http://localhost:19200/metrics-generic.otel-default*/_count"` (số `count` phải tăng sau 15 đến 30 giây). Nếu bằng 0: kiểm tra `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` trong môi trường của wallet/payment (thiếu biến này thì telemetry là no-op), xem log wallet/payment tìm lỗi xuất OTLP, và `docker compose ... logs otel-collector` chỉ để tìm dòng ERROR/WARN về lỗi xuất sang Elasticsearch (collector đặt mức log `warn` nên log trống **không** có nghĩa là không nhận được metric) |
| `local:seed` báo `BILLING_ECOMMERCE_MQ_PASSWORD is not set`      | Không có biến này trong môi trường lẫn `deploy/.env`                                                                              | Đặt trong `deploy/.env` (mật khẩu của user RabbitMQ `ecommerce_orders`) rồi chạy lại                                                        |
| `local:seed` báo top-up không `SUCCEEDED` kịp                    | payment không chạy, hoặc `LOCAL_WEBHOOK_SECRET` của hai service không khớp                                                         | Kiểm tra `http://localhost:3002/health` và log payment/wallet; hai service dùng chung `LOCAL_WEBHOOK_SECRET` trong compose                  |
| Đơn seed bị `INSUFFICIENT_FUNDS` dù không phải đơn lớn           | Seed chỉ nạp tiền một lần mỗi ví; các lần chạy trước đã tiêu hết                                                                  | `down -v` để về số dư ban đầu                                                                                                               |
| `billing-outbox-stuck` báo                                      | `billing.events` không có queue nào gắn vào (ví dụ bạn đã xóa `ecommerce.billing-events`), nên dòng outbox ở lại `pending`        | Chạy lại `local:seed` hoặc tạo queue hứng, xem dưới                                                                                         |
| `billing-dlq-not-empty` báo sau `--with-dlq`                    | Message hỏng nằm trong `wallet.order-payments.dlq`                                                                                | Purge DLQ, xem dưới                                                                                                                         |
| Elasticsearch bị dừng (mã thoát 137) hoặc build image rất chậm / hết bộ nhớ (Windows Docker Desktop) | WSL2 không đủ RAM cho SQL Server (cần tối thiểu 2 GB), Elasticsearch và Kibana chạy cùng nhau; lần `--build` đầu cài toàn bộ dependency và kéo năm image lớn | Tăng bộ nhớ WSL2 (file `%UserProfile%\.wslconfig`, mục `[wsl2] memory=8GB`, rồi `wsl --shutdown` và mở lại Docker Desktop); hạ `ELASTICSEARCH_JAVA_OPTS` nếu cần; lần `--build` đầu mất vài phút đến vài chục phút tùy mạng, các lần sau dùng cache |

### Tạo queue hứng cho `billing.events`

Trên môi trường thật, ecommerce khai báo queue của nó và gắn vào `billing.events`. Local thì `local:seed` tự tạo queue
`ecommerce.billing-events` để đóng vai đó. Nếu queue không tồn tại (bạn xóa nó, hoặc chưa seed), `Paid`/`PaymentFailed`
không có nơi đến: relay publish có `mandatory`, `NO_ROUTE` bị coi là thất bại và dòng outbox được thử lại mãi. Để rule ngừng báo,
chạy lại `corepack pnpm local:seed` hoặc tạo queue hứng bằng tay, cách nào cũng được:

- Giao diện management (`http://localhost:15674`, đăng nhập tài khoản quản trị): Queues, mục Add a new queue, Virtual host
  `billing`, Name `ecommerce.billing-events`, Durable, Add queue; mở queue đó, Bindings, From exchange `billing.events`, Routing
  key `#`, Bind.
- Hoặc bằng API (bash; thay `$USER`, `$PASS` bằng tài khoản quản trị trong `deploy/.env`):

```bash
curl -u "$USER:$PASS" -X PUT -H 'content-type: application/json' \
  -d '{"durable":true}' http://localhost:15674/api/queues/billing/ecommerce.billing-events
curl -u "$USER:$PASS" -X POST -H 'content-type: application/json' \
  -d '{"routing_key":"#"}' http://localhost:15674/api/bindings/billing/e/billing.events/q/ecommerce.billing-events
```

Sau lần thử lại kế tiếp của relay, các dòng outbox được gửi và rule tự hết báo (trong vòng một cửa sổ). Queue này sẽ đầy dần các
event `OrderPaidV1`/`OrderPaymentFailedV1`; purge định kỳ nếu cần. Đừng nhầm đây là hành vi production: nếu để nguyên, cảnh báo
này trên local chỉ là hiện vật của demo.

### Purge DLQ sau `--with-dlq`

DLQ giữ một message cho tới khi có người xử lý, nên `billing-dlq-not-empty` báo (đúng ý) cho tới khi hàng đợi rỗng. Trên local:

- Giao diện management: Queues, vhost `billing`, `wallet.order-payments.dlq`, mục Purge Messages, Purge Messages.
- Hoặc API: `curl -u "$USER:$PASS" -X DELETE http://localhost:15674/api/queues/billing/wallet.order-payments.dlq/contents`
  (trả `204`).

Rule dùng `MIN` độ sâu trong cửa sổ (`windowMinutes`, mặc định 5 phút) nên hết báo ở lần chạy kế tiếp sau **bất kỳ mẫu nào bằng 0** (không cần đủ một cửa sổ rỗng); và có thể báo sớm hơn một cửa sổ đầy sau khi wallet khởi động lại hoặc metric bị đứt quãng. Trên môi trường thật **không purge**: xử lý
theo [dlq-runbook](../integration/dlq-runbook.vi.md).
