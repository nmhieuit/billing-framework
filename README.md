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

## Thanh toán order qua RabbitMQ

Khi ecommerce hoàn tất một order, nó publish `OrderReadyForPaymentV1` vào exchange `orders.events` (vhost `billing`);
wallet trừ ví một lần duy nhất cho mỗi `orderId` và trả `OrderPaidV1` hoặc `OrderPaymentFailedV1` qua `billing.events`.
Thiết kế: [`docs/superpowers/specs/2026-10-10-order-payment-integration-design.md`](docs/superpowers/specs/2026-10-10-order-payment-integration-design.md);
quyết định: ADR-0008, ADR-0009; bàn giao cho ecommerce: [`docs/integration/orders-handoff.vi.md`](docs/integration/orders-handoff.vi.md);
Pact Broker: [`docs/integration/pact-broker.vi.md`](docs/integration/pact-broker.vi.md).

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
```

Nếu testcontainers báo lỗi khởi động container "reaper" (Ryuk), đặt `TESTCONTAINERS_RYUK_DISABLED=true`.
