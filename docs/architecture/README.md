# Quy ước kiến trúc

## Bốn lớp trong mỗi service

`services/<tên>/src/{domain,application,infrastructure,interface}`

| Lớp              | Chứa                                      | Được import                | Không được import                                       |
| ---------------- | ----------------------------------------- | -------------------------- | ------------------------------------------------------- |
| `domain`         | aggregate, value object, domain service   | `@billing/money`           | mọi lớp khác, framework, driver, package dùng chung khác |
| `application`    | use case, port (interface)                | `domain`                   | `infrastructure`, `interface`, framework, driver        |
| `infrastructure` | adapter: DB (Kysely), broker, HTTP client | `application`, `domain`    | `interface`                                             |
| `interface`      | controller, route, consumer               | `application`, `domain`    | `infrastructure`                                        |

Nối dây (composition root) ở `src/main.ts` / `src/app.module.ts`, nơi duy nhất được biết cả hai phía.
Các luật này được ESLint ép (`eslint.config.js`) và có test ở `tools/boundaries.test.ts`.

## Ranh giới giữa service

Service này không import code service kia. Giao tiếp chỉ qua `@billing/contracts` (event) hoặc HTTP có hợp đồng.

## Wallet (NestJS): luôn `@Inject(TOKEN)` tường minh

Không dựa vào metadata kiểu tham số của constructor (`emitDecoratorMetadata`): esbuild/tsx không phát
metadata này. Mỗi port có một token (`Symbol`) và adapter được cung cấp bằng token đó.

## Tiền

Mọi số tiền là `Money` (`@billing/money`): số nguyên minor unit + currency. Không dùng `number` thô cho tiền
ngoài ranh giới (JSON event dùng `{ amount, currency }`).

## Correlation id

Header `x-correlation-id` được nhận hoặc sinh ở rìa HTTP và lan truyền bằng `AsyncLocalStorage`;
logger (`createLogger`) tự gắn vào mọi dòng log.

## Công cụ

- pnpm ghim ở `9.15.9` (cùng phiên bản với repo ecommerce), TypeScript ghim `~5.9` vì typescript-eslint
  chưa hỗ trợ TypeScript 7.

## Truy cập SQL Server (Kysely + tedious)

Các điểm sau đã được kiểm chứng trên SQL Server 2022 và là nguồn gây lỗi âm thầm nếu quên:

- **Ngày giờ:** luôn truyền bằng `dateTime(date)` (`@billing/database`). Truyền `Date` trực tiếp làm mất mili-giây
  vì tedious gửi kiểu `DateTime`. Cột dùng `datetime2(3)`.
- **`bigint` trả về dạng chuỗi:** đọc qua `toSafeInteger`; không bao giờ `Number(x)` trực tiếp cho tiền.
- **Khóa hàng cho worker:** `select top (n) ... with (updlock, readpast, rowlock) ... order by ...` chỉ chia việc đúng
  khi có index hỗ trợ đúng `ORDER BY` (ví dụ `(status, due_at, id)`). Thiếu index thì mọi hàng bị khóa và worker thứ
  hai nhận về rỗng.
- **Vi phạm khóa duy nhất:** nhận biết bằng `isUniqueViolation(error)` (số lỗi 2627/2601).
- **Migration:** `Migrator` nằm ở `kysely/migration`; dùng `migrate(db, migrations, { migrationTableSchema? })` của
  `@billing/database`. `Migrator` dùng `sp_getapplock` nên **phải chạy bằng tài khoản thuộc `db_owner`** (login
  `*_migrator`, biến `*_MIGRATOR_DB_USER/PASSWORD`, đọc bằng `migratorConfigFromEnv`); service chạy bằng login chỉ có
  DML. Lúc khởi động chỉ kiểm tra bằng `pendingMigrations`/`assertMigrated` (chỉ đọc).
- **Từ khóa T-SQL:** tránh đặt tên cột như `key`, `type`, `error`, `at`, `duplicate`.

## Đa tenant (wallet)

Mỗi tenant một schema `t_<tenant>`. Tenant chỉ đến từ header do gateway đặt (API) hoặc từ metadata đã được ký
(webhook), qua `TenantRegistry`; không bao giờ từ body hay query. Mọi truy cập DB đi qua
`TenantUnitOfWork.run(tenant, …)`; Kysely dùng `withSchema`, SQL thô dùng `sql.id(schema, tên)` và tên schema luôn
dựng từ `TenantId` đã kiểm tra. Test tích hợp luôn dựng ít nhất hai tenant để bắt rò rỉ chéo tenant.

## `@billing/runtime`

`Worker` (vòng lặp nền có `AbortSignal`), `runAll`, `once`, `createShutdownHandler`, `startOrExit` dùng chung cho cả
hai service: dừng worker → đóng app → chờ việc đang chạy → đóng DB, luôn chạy hết các bước.

## Kiểm thử

- `*.test.ts`: unit, không cần Docker (`corepack pnpm test`).
- `*.integration.test.ts`: cần Docker (`corepack pnpm test:integration`). Một container SQL Server và một container
  RabbitMQ dùng chung cho cả lượt chạy (`@billing/testing`); mỗi test file tự tạo database riêng bằng
  `createTestDatabase` hoặc vhost riêng bằng `createTestBroker`.
- Test trong `domain/` và `application/` không import `kysely` hay `infrastructure/` (lint cấm); chúng dùng
  `services/<tên>/src/test-support.ts`.
