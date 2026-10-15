# Giáo trình Node.js 1 tuần cho người từ .NET (bám source `billing-framework`)

Người học: software manager, đã có C# hiện đại, ASP.NET Core, EF Core, RabbitMQ, MassTransit; **chưa biết JavaScript/TypeScript**.
Máy Windows + VS Code + Docker Desktop. Thời lượng 4 giờ/ngày × 7 ngày. Thuật ngữ giữ tiếng Anh, kèm giải thích tiếng Việt.

Mục tiêu cuối tuần: **đọc hiểu runtime, debug và troubleshoot** hai service `wallet` (NestJS) và `payment` (Fastify), ưu tiên
nhóm **tiền/ledger/idempotency** rồi **messaging/outbox/DLQ**.

## Lộ trình

| Ngày | Chủ đề | File |
| ---- | ------ | ---- |
| 1 | Công cụ, hệ sinh thái, cú pháp JS/TS nền tảng | [ngay-1](ngay-1-cong-cu-va-cu-phap.md) |
| 2 | Bất đồng bộ, event loop, vòng đời process | [ngay-2](ngay-2-bat-dong-bo-va-vong-doi.md) |
| 3 | Kiến trúc 4 lớp, DI, ranh giới package | [ngay-3](ngay-3-kien-truc-va-di.md) |
| 4 | Dữ liệu, tiền, ledger, idempotency | [ngay-4](ngay-4-du-lieu-tien-ledger.md) |
| 5 | Messaging, outbox, DLQ | [ngay-5](ngay-5-messaging-outbox-dlq.md) |
| 6 | Debug và quan sát | [ngay-6](ngay-6-debug-va-quan-sat.md) |
| 7 | Troubleshoot tổng hợp + kiểm tra cuối tuần | [ngay-7](ngay-7-troubleshoot-tong-hop.md) |

Bài lab chạy được: [labs/event-loop.ts](labs/event-loop.ts) (Ngày 2), [labs/correlation-log.ts](labs/correlation-log.ts) (Ngày 6).

Mỗi ngày: mục tiêu → chuẩn bị → lý thuyết → đọc code → thực hành → thử thách troubleshoot → kiểm tra cuối ngày (có đáp án) → câu hỏi còn mở.

## Cách học

- Làm bài thực hành sửa code trên **nhánh riêng**: `git switch -c hoc/ngay-N`. Hoàn tác nhanh: `git restore <file>` hoặc `git switch -`.
  Bạn đã chọn "sửa code trực tiếp"; nhánh riêng chỉ để dễ quay lại, không bắt buộc.
- Lệnh viết cho **PowerShell** (Windows). Lệnh có `./` trên Linux/macOS đổi thành `.\` trên PowerShell; đường dẫn trong ghi chú dùng `/`, PowerShell chấp nhận cả hai.
- Luôn gọi pnpm qua `corepack pnpm ...` (README repo, mục "Chạy thử").
- Quy ước chú thích: **[ĐÃ CHẠY]** = tác giả giáo trình đã chạy và xem kết quả; **[CHƯA CHẠY]** = chưa kiểm chứng (nêu lý do); **[GIẢ THUYẾT]** = suy luận cần bạn hoặc đội dev xác nhận.
- Phần đối chiếu .NET chỉ là **gần đúng để định hướng**, không phải tương đương tuyệt đối.

## Điều kiện tiên quyết

- Node 22 (`.nvmrc` ghi `22`; `package.json` đặt `engines.node >=22`), Docker Desktop, VS Code. Git.
- Tuần đầu cài: `corepack pnpm install` (tải theo `pnpm-lock.yaml`).

## Nhật ký kiểm chứng của tác giả (môi trường biên soạn: Linux container, **không có Docker, không có Windows/VS Code**)

| Lệnh | Kết quả |
| ---- | ------- |
| `corepack pnpm install --frozen-lockfile` | [ĐÃ CHẠY] OK, pnpm 9.15.9 |
| `corepack pnpm typecheck`, `corepack pnpm lint` | [ĐÃ CHẠY] không lỗi |
| `corepack pnpm test` | [ĐÃ CHẠY] 99 file, 1034 test đều pass |
| `corepack pnpm vitest run packages/money` | [ĐÃ CHẠY] 1 file, 20 test pass |
| `tsx docs/training/nodejs-1-tuan/labs/event-loop.ts` | [ĐÃ CHẠY] thứ tự A, C, B, D |
| `tsx docs/training/nodejs-1-tuan/labs/correlation-log.ts` | [ĐÃ CHẠY] dòng trong `runWithCorrelation` có `correlationId`, dòng ngoài thì không |
| `node --inspect=127.0.0.1:9339 --import tsx ...` | [ĐÃ CHẠY] in `Debugger listening on ws://...` |
| Bỏ `await this.#inflight` ở `worker.ts:49` rồi `vitest run packages/runtime` | [ĐÃ CHẠY] đúng 1 test fail (đã hoàn tác) |
| `vitest run services/wallet/src/domain`; `vitest run packages/messaging services/wallet/src/interface/messaging` | [ĐÃ CHẠY] 106 test; 46 test, đều pass |
| Chèn import `../infrastructure/system.js` vào `services/wallet/src/domain/account.ts` rồi `eslint` | [ĐÃ CHẠY] lỗi `no-restricted-imports` (đã hoàn tác) |
| `test:integration`, `test:chaos`, `docker compose ... local.yml`, `local:seed`, `kibana:*` | [CHƯA CHẠY] cần Docker |
| Debugger VS Code (launch.json, JavaScript Debug Terminal) | [CHƯA CHẠY] không có VS Code |
| Mọi lệnh PowerShell | [CHƯA CHẠY] môi trường biên soạn là Linux |

## Bảng thuật ngữ Node ↔ .NET (gần đúng)

| Node / TS | .NET | Ghi chú |
| --------- | ---- | ------- |
| `package.json` | `.csproj` | khai báo dependency, script |
| `pnpm-workspace.yaml` (`services/*`, `packages/*`) | `.sln` | nhiều project trong một repo |
| npm registry | NuGet | |
| `pnpm-lock.yaml` | `packages.lock.json` | khóa phiên bản |
| `vitest` | xUnit | test runner |
| `eslint` | Roslyn analyzers | luật ranh giới import nằm ở `eslint.config.js` |
| `Promise` | `Task` | Promise chạy ngay khi tạo; một luồng JS |
| `AbortSignal` | `CancellationToken` | |
| `AsyncLocalStorage` | `AsyncLocal<T>` | |
| `Kysely` | EF Core / query builder | Kysely là query builder, không có change tracking [GIẢ THUYẾT: xác nhận khi đọc code Ngày 4] |
| `@Inject(TOKEN)` (NestJS) | đăng ký DI theo key | repo luôn dùng token tường minh |

## Phụ lục: sổ tay lệnh

```powershell
corepack pnpm install
corepack pnpm typecheck; corepack pnpm lint; corepack pnpm test
corepack pnpm vitest run <đường dẫn hoặc tên file>      # chạy một file test
corepack pnpm test:integration <lọc>                     # cần Docker
corepack pnpm test:chaos <lọc> -t S1                     # cần Docker, không dùng `--`
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
corepack pnpm local:seed                                 # thêm `-- --with-dlq` để có message trong DLQ
corepack pnpm kibana:verify
```

Nguồn: README repo, `docs/ops/local-stack.vi.md`, `docs/ops/chaos-testing.vi.md`.
