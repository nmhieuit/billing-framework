# Ngày 3: Kiến trúc 4 lớp, DI và ranh giới package

Khung 4 giờ: Chuẩn bị 15' · Lý thuyết 60' · Đọc code 75' · Thực hành 60' · Thử thách 15' · Kiểm tra 15'.

## Mục tiêu hôm nay
- Vẽ được sơ đồ 4 lớp `domain → application → infrastructure/interface` và giải thích hướng phụ thuộc.
- Hiểu **composition root** (`bootstrap.ts`) và cách NestJS (wallet) nhận use case qua **token tường minh**.
- Biết luật ranh giới được **ép bằng ESLint** và có test (`tools/boundaries.test.ts`).
- Đối chiếu với Clean Architecture / DI của ASP.NET Core.

## Chuẩn bị
`git switch -c hoc/ngay-3`. Đọc nhanh `docs/architecture/README.md` (đã nằm trong repo).

## Lý thuyết

### 1. Bốn lớp trong mỗi service
`services/<tên>/src/{domain,application,infrastructure,interface}` (`docs/architecture/README.md`, mục "Bốn lớp"):

| Lớp | Chứa | Được import | Không được import |
| --- | ---- | ----------- | ----------------- |
| `domain` | aggregate, value object, domain service | `@billing/money` | mọi lớp khác, framework, driver, package dùng chung khác |
| `application` | use case, port (interface) | `domain` | `infrastructure`, `interface`, framework, driver |
| `infrastructure` | adapter DB (Kysely), broker, HTTP client | `application`, `domain` | `interface` |
| `interface` | controller, route, consumer | `application`, `domain` | `infrastructure` |

Đối chiếu .NET (gần đúng): `domain` ≈ project Domain; `application` ≈ Application (use case + interface/port); `infrastructure` ≈ Infrastructure (EF Core/RabbitMQ adapter); `interface` ≈ Web API/consumer host. Khác biệt lớn: ở đây **cả bốn lớp nằm trong một project (một package)**, ranh giới được kiểm bằng lint thay vì bằng tham chiếu project.

### 2. Port và adapter
`application/ports.ts` khai báo interface (ví dụ `Clock`, `IdGenerator`, `Logger`, `EventPublisher`, `TenantUnitOfWork`). `infrastructure` hiện thực chúng (ví dụ `KyselyTenantUnitOfWork`, `AmqpEventPublisher`, `SystemClock`). `bootstrap.ts` nối chúng lại.

### 3. DI trong repo này
- Không có container tự động quét như ASP.NET Core `AddScoped`. **Nối dây thủ công** trong `bootstrap.ts` (composition root): `new PayOrder({ uow, clock, ids, log })` (`bootstrap.ts:158`).
- Riêng phần HTTP của wallet dùng **NestJS**. Quy ước: luôn `@Inject(TOKEN)` tường minh, không dựa vào metadata kiểu của constructor, vì `esbuild/tsx` không phát `emitDecoratorMetadata` (`docs/architecture/README.md`, mục "Wallet (NestJS)").
  - Token là `Symbol`: `tokens.ts:1` `export const TENANT_REGISTRY = Symbol('TENANT_REGISTRY');`
  - Đăng ký: `app.module.ts:91-109` (ví dụ dòng 95) `{ provide: CREATE_WALLET, useValue: deps.createWallet }`
  - Dùng: `wallets.controller.ts:14-17` (dòng 15) `@Inject(CREATE_WALLET) private readonly createWallet: Pick<CreateWallet, 'execute'>`
- `Pick<CreateWallet, 'execute'>` = chỉ lấy phương thức `execute` của lớp: giống interface hẹp (ISP).

### 4. Decorator
`@Controller()`, `@Post('wallets')`, `@UseGuards(CallerGuard)` (`wallets.controller.ts:11-12,20`) tương đương attribute `[ApiController]`, `[HttpPost]`, `[Authorize]`. Guard ≈ authorization filter; middleware ≈ middleware (`correlation.middleware.ts`); `AllExceptionsFilter` ≈ exception filter (`app.module.ts:110`).

### 5. Đa tenant
Mỗi tenant một schema `t_<tenant>`; tenant chỉ đến từ header do gateway đặt hoặc metadata đã ký, qua `TenantRegistry` (`docs/architecture/README.md`, mục "Đa tenant"). `TenantGuard` đọc header `x-tenant-id` (`tenant.guard.ts:21-25`).

## Đọc code có hướng dẫn
1. `eslint.config.js`: `FRAMEWORKS` (dòng 6-17), `LAYERS` (dòng 4), luật cấm import chéo service (dòng 60-64), luật theo lớp (dòng 65-71). *Hỏi*: vì sao phải lặp lại luật chéo-service trong từng lớp? (comment dòng 65: `no-restricted-imports` bị thay thế, không gộp).
2. `tools/boundaries.test.ts`: hàm `violations` (dòng 8-13) chạy ESLint trên chuỗi code giả; các `it` ở dòng 16-70 mô tả từng luật. *Hỏi*: test nào đảm bảo `domain` chỉ được import `@billing/money`? (dòng 34-45)
3. `services/wallet/src/bootstrap.ts` (333 dòng, **composition root**): đọc dòng 74-170 để thấy chuỗi tạo `db → broker → uow → gateway → use case`; dòng 184-204 nối vào `createApp`.
4. `services/wallet/src/app.module.ts`: `AppDeps` (dòng 54-74), `providers` (dòng 90-111), `configure` gắn `CorrelationMiddleware` (dòng 115-117).
5. `services/wallet/src/domain/account.ts`: `Account.apply` (dòng 52-) có `switch` theo `kind` (WALLET, GATEWAY, MERCHANT, ADJUSTMENT) — **luật nghiệp vụ nằm trong domain, không có import framework**.
6. `services/payment/src/main.ts` + `services/payment/src/bootstrap.ts` (123 dòng): payment dùng Fastify thuần, không NestJS. So sánh độ dài với wallet.

## Thực hành
1. **Vi phạm ranh giới có chủ đích**: ở `services/wallet/src/domain/account.ts` thêm hai dòng đầu file
   ```ts
   import { SystemClock } from '../infrastructure/system.js';
   void SystemClock;
   ```
   Chạy `npx eslint services/wallet/src/domain/account.ts`. [ĐÃ CHẠY] kết quả: 1 lỗi `no-restricted-imports`, thông báo "Import từ lớp "infrastructure" vi phạm hướng phụ thuộc". Hoàn tác bằng `git restore`.
2. **Thêm một use case nhỏ đủ 4 lớp** (bài tập tự chọn, có thể giữ trên nhánh học): ví dụ `GET /health` đã có (`health.controller.ts`); hãy đọc nó và `health.controller.test.ts`, rồi tự viết test cho một controller đơn giản mới.
3. **Truy vết một API**: chọn `POST /wallets`. Ghi lại chuỗi `WalletsController.create` (`wallets.controller.ts:20-21`) → `CreateWallet.execute` (`application/create-wallet.ts`) → `uow.run` (`kysely/unit-of-work.ts:22`) → repository. Mỗi bước thuộc lớp nào?
4. Chạy `corepack pnpm vitest run tools/boundaries.test.ts` [ĐÃ CHẠY nằm trong lần chạy `pnpm test` 99 file].

## Thử thách troubleshoot
**Triệu chứng**: wallet khởi động báo lỗi `Nest can't resolve dependencies of the WalletsController` (hoặc controller nhận `undefined`). Đây là lỗi kiểu DI.
Tự lần: nguyên nhân thường gặp trong repo này là gì? Bạn kiểm tra ở đâu?
*Gợi ý*: quy ước token tường minh.
*Đáp án* [GIẢ THUYẾT dựa trên quy ước repo, chưa tái hiện lỗi]: thiếu `@Inject(TOKEN)` ở tham số constructor, hoặc token chưa được đăng ký trong `providers` của `app.module.ts:90-111`. Kiểm tra: tham số có `@Inject(...)`; token có trong `tokens.ts`; `AppDeps` có field tương ứng và `bootstrap.ts` truyền vào `createApp`.

## Kiểm tra cuối ngày
1. Lớp nào được phép biết `kysely`? Lớp nào không?
2. `bootstrap.ts` giữ vai trò gì? Tương đương gì bên ASP.NET Core?
3. Vì sao dùng `Symbol` làm token và `@Inject` tường minh?
4. Ranh giới giữa wallet và payment được đảm bảo thế nào, và hai service giao tiếp bằng gì?
5. Lệnh nào bắt vi phạm ranh giới lớp và test nào kiểm chứng luật?
6. `Pick<CreateWallet, 'execute'>` nghĩa là gì?
7. Tenant của một request lấy từ đâu và KHÔNG được lấy từ đâu?

### Đáp án
1. `infrastructure` (và composition root). `domain` và `application` bị cấm (`eslint.config.js:6-17`, `boundaries.test.ts:24-32,47-55`).
2. Composition root: nối dependency thủ công (`bootstrap.ts:74`). Gần `Program.cs`/`builder.Services` nhưng viết tay, không auto-register.
3. `emitDecoratorMetadata` không được `esbuild/tsx` phát; `Symbol` là khóa duy nhất (`docs/architecture/README.md`, `tokens.ts`).
4. ESLint chặn import chéo service (`eslint.config.js:60-64`); giao tiếp qua `@billing/contracts` (event) hoặc HTTP có hợp đồng (`docs/architecture/README.md`, "Ranh giới giữa service").
5. `corepack pnpm lint`; test `tools/boundaries.test.ts`.
6. Kiểu chỉ gồm phương thức `execute` của lớp `CreateWallet` — dependency hẹp.
7. Từ header do gateway đặt (hoặc metadata đã ký với webhook); không từ body/query (`docs/architecture/README.md`, "Đa tenant").

## Lỗi thường gặp khi chuyển từ .NET sang Node
- Mong đợi DI tự động theo kiểu constructor (như ASP.NET Core): ở đây phải khai báo token.
- Tách project để ép ranh giới: ở đây ranh giới là luật lint; lỗi chỉ lộ khi chạy `lint`.

## Câu hỏi còn mở (cho đội dev)
- Vì sao payment dùng Fastify thuần còn wallet dùng NestJS? (ADR-0003 `docs/adr/0003-nestjs-wallet-fastify-payment.vi.md` — tác giả **chưa đọc**; đọc nó là bài tập về nhà.)
- `Account.apply` có `case 'ADJUSTMENT'` — quy tắc cụ thể chưa đọc hết (`account.ts:75-`).


## Thực hành mở rộng: debug `POST /topups` wallet → payment với correlation id

Hướng dẫn setup và từng bước debug trên local (VS Code) và Docker Desktop: [ngay-3-huong-dan-debug-topup.md](ngay-3-huong-dan-debug-topup.md). Lưu ý phát hiện chính (đã chạy lab): wallet **chưa** gửi `x-correlation-id` sang payment; hướng dẫn bám hành vi hiện tại, không sửa code.


## Sơ đồ runtime (draw.io)

- [diagrams/runtime-request-sequence.drawio](diagrams/runtime-request-sequence.drawio): sequence diagram của `GET /wallet`. Trang 1: một request (14 bước, kèm bảng số mũi tên → hàm → file:dòng). Trang 2: hai request chồng nhau (luồng JS duy nhất, pool kết nối, ngữ cảnh riêng từng request).
- Bằng chứng chạy thật: lab [labs/get-wallet-http-trace.ts](labs/get-wallet-http-trace.ts) (NestJS + Fastify + `GetWallet` thật, DB giả). Mở file `.drawio` bằng draw.io Desktop, app.diagrams.net hoặc extension VS Code "Draw.io Integration".
