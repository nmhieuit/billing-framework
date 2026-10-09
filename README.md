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
team ecommerce trước khi làm Wallet core.

## Hợp đồng với ecommerce

JSON Schema nằm ở `packages/contracts`. Xuất ra file để team ecommerce lấy:

```bash
corepack pnpm --filter @billing/contracts emit    # → packages/contracts/dist/schemas/
```
