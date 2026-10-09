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
