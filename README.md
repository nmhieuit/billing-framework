# billing-framework

Hai microservice thanh toán độc lập với ecommerce:

- **payment** (Fastify): giả lập cổng thanh toán — charge, webhook, kịch bản lỗi, sao kê.
- **wallet** (NestJS): ví nạp trước, ledger ghi sổ kép, thanh toán order bất đồng bộ, chống trùng, đối soát.

Thiết kế: [`docs/superpowers/specs/2026-10-09-billing-framework-design.md`](docs/superpowers/specs/2026-10-09-billing-framework-design.md).
Quyết định kiến trúc: [`docs/adr/`](docs/adr/). Quy ước code: [`docs/architecture/README.md`](docs/architecture/README.md).

## Chạy thử

Yêu cầu: Node 22, Docker. pnpm chạy qua corepack với phiên bản ghim trong `package.json` (không cần cài riêng).
Nếu `corepack enable` báo lỗi quyền, bỏ qua và luôn gọi qua tiền tố `corepack pnpm`.

```bash
corepack pnpm install
corepack pnpm test            # unit + kiểm tra ranh giới kiến trúc
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @billing/wallet-service dev    # :3001/health
corepack pnpm --filter @billing/payment-service dev   # :3002/health
```

## Chạy local một lệnh và quan sát

Dựng cả SQL Server, RabbitMQ, Elasticsearch, Kibana, OTel Collector, wallet và payment trên máy (độc lập với stack ecommerce),
kèm 9 rule cảnh báo và dashboard "Billing: vận hành" trên Kibana (cần Docker; Kibana/Elasticsearch 9.4).

```bash
cp deploy/.env.example deploy/.env      # điền các mật khẩu mẫu local
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
corepack pnpm local:seed                # dữ liệu mẫu (thêm `-- --with-dlq` để thấy cảnh báo DLQ)
corepack pnpm kibana:verify             # kiểm tra rule, dashboard và mọi câu ES|QL
```

Kibana: <http://localhost:15601> (Rules, tag `billing`; Dashboards, "Billing: vận hành"). Đổi ngưỡng bằng
`deploy/kibana/params.local.json` rồi `corepack pnpm kibana:apply`. Chi tiết:
[`docs/ops/local-stack.vi.md`](docs/ops/local-stack.vi.md) (cổng, sự cố thường gặp),
[`docs/ops/kibana-alerts-and-dashboard.vi.md`](docs/ops/kibana-alerts-and-dashboard.vi.md) (bảng tham số, quy trình đổi),
[ADR-0011](docs/adr/0011-otel-metrics-and-generated-kibana-rules.vi.md).

## Công cụ vận hành (ops)

Wallet có nhóm API `/ops/...` cho người vận hành: đóng/mở băng ví, điều chỉnh số dư, đảo một giao dịch (`ORDER_PAYMENT`/`ADJUSTMENT`) và
phát lại `OrderPaidV1`. Mọi thao tác bắt buộc có `reason` và `idempotencyKey`, chạy trong cùng transaction với một dòng nhật ký
`ops_actions` chỉ thêm. Danh tính lấy từ header gateway `x-actor-id` và `x-actor-role: OPS` (gateway phải xóa `x-actor-*` do client gửi);
**chỉ dành cho mạng vận hành**, không đưa vào route hướng khách. Ví đóng băng từ chối trả order bằng `OrderPaymentFailedV1(WALLET_FROZEN)`.
Hướng dẫn, ví dụ `curl` và mã lỗi: [`docs/ops/ops-tools.vi.md`](docs/ops/ops-tools.vi.md); quyết định:
[ADR-0013](docs/adr/0013-ops-tools-audited-actions.vi.md).

## Dọn dữ liệu (retention)

Wallet và payment mỗi service có một job nền xóa định kỳ dữ liệu đã hết giá trị: outbox `SENT` (14 ngày), `processed_messages`
(30 ngày), `idempotency_keys` (90 ngày), mục/lượt đối soát đã đóng (365 ngày) ở wallet; webhook đã giao (30 ngày) và
`idempotency_keys` (90 ngày) ở payment. Xóa theo lô nhỏ, **không bao giờ chạm vào sổ cái, `accounts`, `topups`, `order_payments`
hay `charges`**. Job bật sẵn nhưng **chạy thử** (`RETENTION_DRY_RUN=true`: chỉ đếm và log): xem số `would_delete` trên dashboard,
rồi mới đặt `RETENTION_DRY_RUN=false` để xóa thật (không hoàn tác; production sao lưu DB trước). Số ngày chỉnh bằng `RETENTION_*`
(có mức tối thiểu; xem `services/wallet/.env.example`, `services/payment/.env.example`). Chi tiết:
[`docs/ops/retention.vi.md`](docs/ops/retention.vi.md) (chính sách, quy trình chạy thử sang xóa thật, đọc metric và rule
`billing-retention-stalled`), [ADR-0012](docs/adr/0012-batched-dry-run-first-retention.vi.md).

## Chaos test

Bộ test cố tình làm hỏng SQL Server (`KILL` session), RabbitMQ (rớt kết nối, publish trùng/mất), đường HTTP wallet ↔ payment
(5xx, chậm, mất, webhook trùng/muộn) và chính dịch vụ (`SIGKILL`), rồi đối chiếu 8 bất biến về tiền (sổ cái cân, không ghi nợ hai lần,
nạp tiền khớp payment, outbox ít nhất một lần, đối soát hội tụ, ops nguyên tử, retention an toàn, phục hồi). Cần Docker (testcontainers,
**không** dùng stack `billing-local`); không nằm trong `test` hay `test:integration`.

```bash
corepack pnpm test:chaos         # 13 kịch bản xác định (S1-S13), test công cụ và một vòng soak ngắn với seed cố định
corepack pnpm test:chaos:soak    # bài soak dài, ngẫu nhiên; chỉnh bằng CHAOS_SEED, CHAOS_ROUNDS, CHAOS_MAX_SECONDS, CHAOS_MODE
```

Hướng dẫn chạy một kịch bản, đọc nhật ký lỗi (`tests/chaos/.out/`), tái hiện từ seed, thêm kịch bản và giới hạn:
[`docs/ops/chaos-testing.vi.md`](docs/ops/chaos-testing.vi.md); quyết định: [ADR-0014](docs/adr/0014-chaos-tests-in-process-and-child.vi.md);
kết quả và ghi chú vận hành: [`docs/ops/chaos-findings.vi.md`](docs/ops/chaos-findings.vi.md).

## Đo hiệu năng

Bộ đo tải vòng kín ở mức use case (trả order, nạp tiền, hỗn hợp) và đầu-cuối trên SQL Server/RabbitMQ của testcontainers (**không** dùng
stack `billing-local`), ghi báo cáo JSON + Markdown vào `tests/perf/.out/`. Cần Docker và máy rảnh; không nằm trong `test`, `test:integration`
hay CI. Luôn lọc theo tệp:

```bash
corepack pnpm test:perf matrix       # ma trận đầy đủ (mức 1/4/16/64 × 3 lần lặp + đầu-cuối), 30–50 phút; chỉnh bằng PERF_*
corepack pnpm test:perf pay-order    # một kịch bản (cũng: topup-apply, mixed, e2e, canary)
```

Cách chạy, biến `PERF_*`, cách đọc báo cáo, baseline và phân tích điểm nóng MERCHANT:
[`docs/perf/merchant-hotspot.vi.md`](docs/perf/merchant-hotspot.vi.md).

## Hạ tầng dùng chung với ecommerce

Billing dùng chung nền tảng (SQL Server, RabbitMQ, K8s, CI, observability, Vault) nhưng cô lập dữ liệu:
DB, user SQL, vhost và user RabbitMQ riêng. Khởi tạo trên stack ecommerce đang chạy:

```bash
cp deploy/.env.example deploy/.env   # điền mật khẩu và tên network/host của stack ecommerce
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-sql-init
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-rabbitmq-init
```

Lưu ý quan trọng — cấu hình mặc định giả định stack đầy đủ của ecommerce (`docker-compose.yml`: một `sqlserver`
dùng chung, network `ecomerce-stack_backbone`). Stack local (`docker-compose.local.yml`) khác: network
`ecomerce-local_backbone` và **mỗi service một container SQL Server riêng**, không có `sqlserver` chung. Chọn instance
SQL nào chứa DB của billing, và cách service chạy trên host truy cập cổng SQL/RabbitMQ, là việc cần thống nhất với
team ecommerce trước khi chạy thật; danh sách tenant của wallet (`WALLET_TENANTS`) cũng phải khớp với các tenant của gateway ecommerce.

## Hợp đồng với ecommerce

JSON Schema nằm ở `packages/contracts`. Xuất ra file để team ecommerce lấy:

```bash
corepack pnpm --filter @billing/contracts emit    # → packages/contracts/dist/schemas/
```

## Payment simulator

Cổng thanh toán giả lập. Thiết kế: [`docs/superpowers/specs/2026-10-09-payment-simulator-design.md`](docs/superpowers/specs/2026-10-09-payment-simulator-design.md).

```bash
# 1. Tạo schema (DB billing_payment phải tồn tại; xem deploy/compose.billing.yml).
#    Migration cần tài khoản db_owner: đặt thêm PAYMENT_MIGRATOR_DB_USER/PASSWORD (thực tế bắt buộc vì Kysely Migrator cần db_owner; để trống chỉ chạy được khi chính tài khoản ứng dụng là db_owner, tức môi trường local/dev).
PAYMENT_DB_HOST=... PAYMENT_DB_NAME=billing_payment PAYMENT_DB_USER=... PAYMENT_DB_PASSWORD=... \
  PAYMENT_MIGRATOR_DB_USER=... PAYMENT_MIGRATOR_DB_PASSWORD=... \
  corepack pnpm db:migrate:payment

# 2. Chạy service (biến môi trường: services/payment/.env.example)
corepack pnpm --filter @billing/payment-service start
```

Gọi thử:

```bash
curl -s -X POST localhost:3002/charges \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' -H 'x-simulate: fail=card_declined' \
  -d '{"amount":150000,"currency":"VND","reference":"topup-1"}'
```

`X-Simulate`: `fail=<code>`, `delay=<giây>`, `webhook=drop|duplicate`, `response=timeout` (kết hợp bằng dấu phẩy).

`POST /charges` nhận thêm `metadata` tùy chọn (tối đa 10 khóa chuỗi→chuỗi); payment lưu và trả lại trong `GET /charges/{id}`, webhook (`data.metadata`) và sao kê.

## Wallet

Ví nạp trước theo khách hàng và theo tenant, ledger ghi sổ kép bất biến, nạp tiền qua payment.
Thiết kế: [`docs/superpowers/specs/2026-10-10-wallet-core-design.md`](docs/superpowers/specs/2026-10-10-wallet-core-design.md);
quyết định: ADR-0002, ADR-0006, ADR-0007.

```bash
# 1. Cấp phát các tenant (tạo schema t_<tenant> rồi migrate; biến môi trường: services/wallet/.env.example)
#    Cần tài khoản migrator (db_owner) vì Kysely Migrator đòi quyền đó; bỏ trống *_MIGRATOR_DB_* chỉ chạy được khi
#    chính tài khoản ứng dụng là db_owner (local/dev). Tài khoản ứng dụng ở production chỉ có DML.
WALLET_DB_HOST=... WALLET_DB_NAME=billing_wallet WALLET_DB_USER=... WALLET_DB_PASSWORD=... \
  WALLET_MIGRATOR_DB_USER=... WALLET_MIGRATOR_DB_PASSWORD=... WALLET_TENANTS=acme,beta \
  corepack pnpm db:migrate:wallet

# 2. Chạy service (từ chối khởi động nếu còn tenant chưa migrate)
corepack pnpm --filter @billing/wallet-service start
```

Gọi thử (tenant và khách do gateway đặt qua header):

```bash
H='-H x-tenant-id:acme -H x-customer-id:c1 -H content-type:application/json'
curl -s -X POST localhost:3001/wallets $H -d '{"currency":"VND"}'
curl -s -X POST localhost:3001/topups $H -H 'idempotency-key: demo-1' -d '{"amount":150000}'
curl -s localhost:3001/wallet $H
curl -s localhost:3001/wallet/entries $H
```

`POST /topups` luôn trả `202`; số dư tăng khi payment gửi webhook `charge.succeeded` về `POST /webhooks/payment`
(đặt `WEBHOOK_URL` của payment trỏ vào đó và dùng chung `WEBHOOK_SECRET` = `PAYMENT_WEBHOOK_SECRET`).

### Đối soát

Mỗi ngày (sau `RECONCILE_AT_UTC_HOUR`) wallet đối soát ngày D-1 UTC cho từng tenant: toàn vẹn ledger (giao dịch cân, số dư
cache khớp sổ cái) và Wallet ↔ Gateway (sao kê của payment so với `topups`). Lệch `MISSING_AT_WALLET` (webhook bị mất) được tự
ghi bù qua đường nạp bình thường; mọi lệch khác thành ca thủ công. Lượt chạy bất biến. Endpoint chỉ dành cho **mạng vận hành**: không đưa vào bộ route hướng khách hàng của gateway (caller phía khách có header tenant sẽ chạy được đối soát và đóng ca dưới tên giả); dùng network policy hoặc route gateway riêng có xác thực vận hành:

```bash
H='-H x-tenant-id:acme -H content-type:application/json'
curl -s -X POST localhost:3001/reconciliations $H -d '{"date":"2026-10-09"}'   # 202 {runId}
curl -s localhost:3001/reconciliations/<runId> $H                               # trạng thái, tổng kiểm
curl -s "localhost:3001/reconciliations/<runId>/items?caseStatus=OPEN" $H       # các ca còn mở
curl -s -X POST localhost:3001/reconciliation-items/<itemId>/resolve $H \
  -d '{"status":"RESOLVED","note":"đã xử lý","resolvedBy":"an.nguyen"}'        # đóng ca
```

Cấu hình: `RECONCILE_AUTOFIX` (`true`), `RECONCILE_AT_UTC_HOUR` (`2`), `RECONCILE_MAX_ATTEMPTS` (`3`),
`RECONCILE_MAX_ITEMS` (`50000`). Thiết kế: [`docs/superpowers/specs/2026-10-10-reconciliation-design.md`](docs/superpowers/specs/2026-10-10-reconciliation-design.md);
quyết định: [ADR-0010](docs/adr/0010-reconciliation-read-only-immutable-runs.vi.md);
vận hành: [`docs/integration/reconciliation-runbook.vi.md`](docs/integration/reconciliation-runbook.vi.md);
hợp đồng Wallet ↔ Orders (chưa chạy): [`docs/integration/orders-reconciliation.vi.md`](docs/integration/orders-reconciliation.vi.md).

## Thanh toán order qua RabbitMQ

Khi ecommerce hoàn tất một order, nó publish `OrderReadyForPaymentV1` vào exchange `orders.events` (vhost `billing`);
wallet trừ ví một lần duy nhất cho mỗi `orderId` và trả `OrderPaidV1` hoặc `OrderPaymentFailedV1` qua `billing.events`.
Thiết kế: [`docs/superpowers/specs/2026-10-10-order-payment-integration-design.md`](docs/superpowers/specs/2026-10-10-order-payment-integration-design.md);
quyết định: ADR-0008, ADR-0009; bàn giao cho ecommerce: [`docs/integration/orders-handoff.vi.md`](docs/integration/orders-handoff.vi.md);
Pact Broker: [`docs/integration/pact-broker.vi.md`](docs/integration/pact-broker.vi.md);
xử lý hàng đợi chết `wallet.order-payments.dlq`: [`docs/integration/dlq-runbook.vi.md`](docs/integration/dlq-runbook.vi.md).

`BILLING_ECOMMERCE_MQ_PASSWORD` (cùng các `BILLING_*_MQ_PASSWORD` khác) phải được đặt trong `deploy/.env` **trước** khi chạy
`billing-rabbitmq-init`. Mật khẩu chỉ gồm chữ, số, `-` và `_` (không có `"` hoặc `\`) vì script nhúng nó vào JSON.

```bash
# 1. Tạo vhost, user và exchange tích hợp trên RabbitMQ dùng chung (xem deploy/compose.billing.yml)
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-rabbitmq-init

# 2. Chạy wallet với RABBITMQ_* (xem services/wallet/.env.example)
corepack pnpm --filter @billing/wallet-service start
```

### Test

```bash
corepack pnpm test               # unit, không cần Docker
corepack pnpm test:integration   # cần Docker: chạy SQL Server 2022 bằng testcontainers (lần đầu kéo image)
corepack pnpm test:chaos         # cần Docker: chaos test (mục "Chaos test" ở trên), không nằm trong hai lệnh trên
```

Nếu testcontainers báo lỗi khởi động container "reaper" (Ryuk), đặt `TESTCONTAINERS_RYUK_DISABLED=true`.
