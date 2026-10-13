# Chaos Tests (Step 6d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bộ chaos test tự động (`corepack pnpm test:chaos`) gây lỗi có chủ đích ở SQL Server, RabbitMQ, payment/webhook và crash service, với oracle bất biến dùng chung, 13 kịch bản xác định và một bài soak ngẫu nhiên có seed; sửa/ghi nhận các lỗi thật mà nó tìm ra.

**Architecture:** Thư mục `tests/chaos/` (cấu hình vitest riêng, tệp `*.chaos.test.ts`) dùng lại `globalSetup` testcontainers. Bộ công cụ gây lỗi (`FaultPlan`, bọc dialect Kysely để KILL/chặn theo lệnh hoặc commit, bọc publisher, proxy HTTP giữa wallet và payment) nằm trong `tests/chaos/support/`. Hệ thống dưới test chạy trong tiến trình (nhanh) hoặc tiến trình con (`SIGKILL` để mô phỏng crash thật). Hai seam nhỏ, mặc định không làm gì, được thêm vào code production: tuỳ chọn bọc dialect khi tạo database và bọc publisher của wallet.

**Tech Stack:** TypeScript, vitest, testcontainers (SQL Server 2022 + RabbitMQ), Kysely/tedious, Fastify/Nest (dịch vụ), `tsx` (tiến trình con), `corepack pnpm`.

## Global Constraints

Spec: `docs/superpowers/specs/2026-10-12-chaos-tests-design.md` (đọc trước khi làm bất kỳ task nào). Giá trị dưới đây chép từ spec.

- Chạy lệnh bằng `corepack pnpm`. Không push, không merge. Không commit `deploy/.env`, `deploy/kibana/params.local.json`, hay `tests/chaos/.out/`. Không ghi bí mật vào log/commit. Không `docker compose down`; chaos test KHÔNG đụng stack `billing-local` (chỉ dùng testcontainers).
- Comment trong code bằng tiếng Việt (như code xung quanh); tên test bằng tiếng Anh. Không thêm thư viện production; dev-dependency chỉ khi thật cần và nêu rõ trong báo cáo.
- ESLint hexagonal giữ nguyên cho `services/*`: `domain` chỉ import `@billing/money`; `application` không import framework/`infrastructure`/Kysely/OpenTelemetry; `interface` không import `infrastructure`. Code `tests/chaos/**` được import từ services nhưng KHÔNG ngược lại.
- Lệnh: `corepack pnpm test:chaos` → `vitest run --config vitest.chaos.config.ts`; include `tests/chaos/**/*.chaos.test.ts`; dùng `globalSetup: ['./packages/testing/src/containers.global-setup.ts']`; `fileParallelism: false`; `testTimeout` 120 000 ms, `hookTimeout` 180 000 ms. `test:chaos` KHÔNG nằm trong `test:integration` (`vitest.integration.config.ts` chỉ lấy `**/*.integration.test.ts` — đặt tên tệp chaos khác hẳn để không bị lấy nhầm). Các test thuần (không cần container) trong `tests/chaos/support/*.test.ts` chạy cùng `corepack pnpm test`.
- `KILL` chỉ nhắm session của ĐÚNG database test (tên ngẫu nhiên do `createTestDatabase`), không bao giờ `master`/DB khác; không dừng/pause container.
- Mọi chỗ chờ phải theo điều kiện có timeout (`waitFor`/`quiesce`); không dùng `sleep` cố định để quyết định đạt/không đạt (chờ âm có thể dùng khoảng chờ rộng SAU khi điều kiện chính đã xác nhận).
- Seed: `CHAOS_SEED` (số nguyên 32 bit; mặc định ngẫu nhiên và LUÔN in ra), `CHAOS_ROUNDS` (mặc định 3), `CHAOS_MAX_SECONDS` (mặc định 30 mỗi vòng). Khi test chaos thất bại phải ghi seed, nhật ký lỗi và nhật ký thao tác vào `tests/chaos/.out/<tên>-<seed>.json` (thư mục git-ignored).
- 13 kịch bản xác định S1–S13 và bài soak đúng như spec §4–§5; 8 bất biến đúng như spec §3.
- Chính sách lỗi tìm thấy (spec §1 #5): lỗi nhỏ và rõ (dưới khoảng 50 dòng) → sửa ngay bằng commit RIÊNG kèm test tái hiện, ghi rõ trong báo cáo; lỗi lớn hoặc cần quyết định thiết kế → KHÔNG tự sửa: thêm mục vào `docs/ops/chaos-findings.vi.md`, viết test tái hiện đánh dấu `it.fails(...)`/bỏ qua có tham chiếu mục đó, và báo ngay cho người điều phối (BLOCKED-with-finding hoặc DONE_WITH_CONCERNS).
- Seam production (spec §1 #6): `createDatabase(config, options?: { wrapDialect?: (dialect: Dialect) => Dialect })` trong `@billing/database`; `StartOverrides.wrapDialect` ở cả wallet và payment (truyền xuống `createDatabase`); `StartOverrides.wrapPublisher?: (publisher: EventPublisher) => EventPublisher` ở wallet. Mặc định không đổi hành vi (có unit test). **Lưu ý lệch spec:** spec §1/§2 viết `dbPlugins` (Kysely plugin); plugin của Kysely không thể `await` trước khi chạy lệnh và không thấy `commit`, nên kế hoạch dùng bọc dialect. Task 12 sửa lại chữ trong spec cho khớp.
- Baseline trước tính năng: 844 unit, 609 integration, 2 contract; số mới phải cao hơn; `test:integration` không được đổi thời gian đáng kể.

---

## File Structure

| Tệp | Vai trò |
|---|---|
| `vitest.chaos.config.ts`, `package.json` (`test:chaos`), `.gitignore` (`tests/chaos/.out/`) | cấu hình chạy |
| `packages/database/src/connection.ts` (+test) | seam `wrapDialect` |
| `services/wallet/src/bootstrap.ts`, `services/payment/src/bootstrap.ts` | seam trong `StartOverrides` |
| `tests/chaos/support/prng.ts`, `op-log.ts`, `fault-plan.ts`, `quiesce.ts` | lõi công cụ (thuần) |
| `tests/chaos/support/sql-faults.ts` | `killSessions`, dialect bọc |
| `tests/chaos/support/broker-faults.ts`, `http-fault-proxy.ts` | lỗi publisher/broker, proxy HTTP |
| `tests/chaos/support/system-harness.ts`, `crash.ts` | dựng hệ thống trong tiến trình / tiến trình con |
| `tests/chaos/support/invariants.ts` | oracle `assertSystemInvariants` |
| `tests/chaos/*.chaos.test.ts` | kịch bản, soak, test của công cụ và oracle |
| `docs/...` | Task 12 |

---

### Task 1: Cấu hình chạy và hai seam production

**Files:**
- Create: `vitest.chaos.config.ts`, `tests/chaos/.gitkeep` (hoặc tệp đầu tiên của task 2), `tests/chaos/support/harness.smoke.chaos.test.ts` (smoke: một test chạy được dưới cấu hình mới và thấy `inject('sqlServer')`)
- Modify: `package.json` (script `test:chaos`), `.gitignore`, `packages/database/src/connection.ts` (+ `connection.test.ts`), `services/wallet/src/bootstrap.ts`, `services/payment/src/bootstrap.ts` (+ test mặc định không đổi), `tsconfig`/ESLint nếu cần cho `tests/chaos/**` (kiểm tra `corepack pnpm lint && corepack pnpm typecheck` thấy tệp mới)

**Interfaces:**
- Produces:
  - `createDatabase<DB>(config: DatabaseConfig, options?: { wrapDialect?: (dialect: Dialect) => Dialect }): Kysely<DB>` — nếu có `wrapDialect` thì dùng `wrapDialect(new MssqlDialect(...))`, ngược lại như cũ (`Dialect` là kiểu của Kysely).
  - Wallet: `StartOverrides.wrapDialect?: (dialect: Dialect) => Dialect` truyền vào `createDatabase(config.database, { wrapDialect })`; `StartOverrides.wrapPublisher?: (publisher: EventPublisher) => EventPublisher` bọc `new AmqpEventPublisher(broker.publisher)` khi dựng `RelayOutbox`. Payment: `StartOverrides.wrapDialect` tương tự. Chú thích tiếng Việt: chỉ dùng cho test.

- [ ] **Step 1: Viết test thất bại.** `connection.test.ts` (unit thuần, không cần DB): `createDatabase(config)` không gọi `wrapDialect` khi không truyền; khi truyền, hàm được gọi đúng một lần với một `Dialect` có `createDriver` và Kysely dùng dialect trả về (kiểm bằng cách trả về dialect giả ghi nhận lời gọi `createDriver`). Test đơn vị cho bootstrap: dựa vào mẫu test bootstrap hiện có (hoặc test nhỏ riêng) chứng minh `startService` không truyền `wrapDialect`/`wrapPublisher` thì hành vi như cũ (các test integration hiện có là bằng chứng chính; thêm một unit test cho đường nối `wrapPublisher` nếu bootstrap tách được, nếu không ghi rõ trong báo cáo vì sao integration test đủ).
- [ ] **Step 2: Chạy** `corepack pnpm exec vitest run packages/database` → FAIL.
- [ ] **Step 3: Cài đặt** các seam; tạo `vitest.chaos.config.ts` (xem Global Constraints) và script `test:chaos`; smoke test `harness.smoke.chaos.test.ts` dùng `createTestDatabase('chaos_smoke')`, chạy `select 1`, rồi `drop`; thêm `tests/chaos/.out/` vào `.gitignore`.
- [ ] **Step 4: Chạy** `corepack pnpm exec vitest run packages/database`, `corepack pnpm test:chaos`, `corepack pnpm test:integration wallet payment` (hai dịch vụ vẫn xanh, vì bootstrap đổi), `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add vitest.chaos.config.ts package.json .gitignore packages services tests
git commit -m "feat(chaos): chaos test runner config and test-only dialect/publisher seams

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Lõi công cụ — `prng`, `op-log`, `fault-plan`, `quiesce`

**Files:**
- Create: `tests/chaos/support/prng.ts`, `op-log.ts`, `fault-plan.ts`, `quiesce.ts` và các test đơn vị `*.test.ts` cùng tên (thuần, chạy trong `corepack pnpm test`)

**Interfaces:**
- Produces:
  ```ts
  // prng.ts
  export interface Prng { next(): number; int(min: number, max: number): number; chance(p: number): boolean; pick<T>(items: readonly T[]): T; fork(label: string): Prng }
  export function createPrng(seed: number): Prng              // mulberry32; fork(label) cho dòng con xác định theo (seed, label)
  export function resolveSeed(env: NodeJS.ProcessEnv): number // CHAOS_SEED hợp lệ (số nguyên 0..2^32-1) hoặc ngẫu nhiên; ném lỗi rõ nếu CHAOS_SEED sai định dạng
  // op-log.ts
  export interface OpLogEntry { t: number; kind: string; detail?: Record<string, unknown> }  // t = ms từ lúc bắt đầu
  export class OpLog { record(kind: string, detail?: Record<string, unknown>): void; entries(): readonly OpLogEntry[]; writeTo(dir: string, name: string): Promise<string> }
  // fault-plan.ts
  export type FaultInfo = Record<string, unknown>
  export interface FaultRule { point: string; when?: (info: FaultInfo) => boolean; nth?: number; probability?: number; times?: number; label?: string; action: (info: FaultInfo) => void | Promise<void> }
  export class FaultPlan {
    constructor(options: { log: OpLog; prng?: Prng })
    add(rule: FaultRule): this
    hit(point: string, info?: FaultInfo): Promise<void>   // đếm theo (rule), chạy action của các rule khớp, ghi vào log mỗi lần kích hoạt
    hits(point: string): number                            // tổng số lần hit điểm này
    fired(label?: string): number
    disable(): void; enable(): void; clear(): void
  }
  // quiesce.ts
  export interface QuiesceCondition { name: string; check: () => Promise<boolean> }
  export function quiesce(conditions: readonly QuiesceCondition[], options?: { timeoutMs?: number; intervalMs?: number }): Promise<void>
  ```
  Ngữ nghĩa `FaultRule`: `nth` đếm trên các lần hit KHỚP `point` và `when` (1 = lần đầu); đặt `nth` thì rule chỉ kích hoạt đúng lần thứ n; `probability` (0..1) dùng `prng` (bắt buộc có prng nếu dùng) và kết hợp được với `times` (tối đa số lần kích hoạt); không đặt gì thì kích hoạt mọi lần khớp. `hit` KHÔNG ném khi action ném — lỗi của action được ném lên người gọi (để hành động kiểu "ném lỗi giả" hoạt động); `disable()` làm `hit` trả ngay không làm gì. `quiesce` ném `Error` liệt kê TÊN các điều kiện chưa đạt khi hết hạn (mặc định `timeoutMs` 60 000, `intervalMs` 200); điều kiện ném lỗi coi như chưa đạt (ghi lỗi cuối cùng vào thông báo).

- [ ] **Step 1: Viết test thất bại** — `prng`: cùng seed cho cùng dãy, `fork('a')` ổn định và khác `fork('b')`, `int` trong khoảng đóng, `resolveSeed` chấp nhận/từ chối đúng; `op-log`: ghi và đọc theo thứ tự, `writeTo` tạo tệp JSON đọc lại được trong thư mục tạm; `fault-plan`: `nth` đúng lần, `when` lọc và `nth` đếm sau lọc, `times`, `probability` xác định theo seed (cùng seed cùng chuỗi kích hoạt), `disable/enable/clear`, action ném lỗi truyền lên, mỗi kích hoạt có một mục log (`kind: 'fault'`, `detail.point`, `detail.label`); `quiesce`: đạt khi mọi điều kiện đúng (kể cả đạt sau vài vòng), hết hạn ném lỗi nêu tên điều kiện, điều kiện ném lỗi không làm hỏng vòng lặp.
- [ ] **Step 2: Chạy** `corepack pnpm exec vitest run tests/chaos/support` → FAIL.
- [ ] **Step 3: Cài đặt** đúng Interfaces.
- [ ] **Step 4: Chạy** `corepack pnpm exec vitest run tests/chaos/support`, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/chaos
git commit -m "feat(chaos): prng, op log, fault plan and quiesce

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Lỗi SQL Server — `killSessions` và dialect bọc

**Files:**
- Create: `tests/chaos/support/sql-faults.ts`, `tests/chaos/support/sql-faults.chaos.test.ts`

**Interfaces:**
- Consumes: `FaultPlan` (Task 2), seam `wrapDialect` (Task 1).
- Produces:
  ```ts
  export function killSessions(config: DatabaseConfig): Promise<number>
  // KILL mọi session của database config.database (trừ session của chính lệnh gọi); trả về số session bị giết. TỪ CHỐI (ném) nếu config.database là 'master' | 'tempdb' | 'model' | 'msdb' hoặc rỗng.
  export function faultyDialect(plan: FaultPlan, options?: { name?: string }): (dialect: Dialect) => Dialect
  // Dialect bọc: tại mỗi lời gọi của connection nó `await plan.hit(point, info)` với info.sql (chuỗi SQL đã biên dịch, chữ thường), info.name; các điểm:
  //   'sql.query.before' / 'sql.query.after' (trước/sau executeQuery), 'sql.begin.after', 'sql.commit.before', 'sql.commit.after', 'sql.rollback.before'.
  // Action của rule có thể ném lỗi giả (như mất kết nối) hoặc gọi killSessions(config) — lệnh kế tiếp trên kết nối đó sẽ thất bại thật.
  ```
  `name` ('wallet' | 'payment') được thêm vào `info.name` để rule chọn đúng dịch vụ. Dùng `Dialect`/`Driver`/`DatabaseConnection` của Kysely: bọc `createDriver()` → `acquireConnection()` → đối tượng kết nối bọc chuyển tiếp mọi phương thức (`executeQuery`, `streamQuery`, `beginTransaction`, `commitTransaction`, `rollbackTransaction`), còn `init/releaseConnection/destroy` chuyển tiếp nguyên vẹn.

- [ ] **Step 1: Viết test thất bại** (`sql-faults.chaos.test.ts`, trên SQL Server thật; mỗi test tạo database riêng bằng `createTestDatabase('chaos_sql')`): (a) `killSessions` giết kết nối đang nhàn rỗi của pool → lệnh kế tiếp ban đầu có thể lỗi nhưng sau đó pool tạo kết nối mới và lệnh thành công (ghi lại hành vi quan sát được, đây cũng là bằng chứng cho bất biến 8; nếu pool KHÔNG hồi phục là lỗi thật → áp dụng chính sách lỗi); (b) `killSessions` không ảnh hưởng database khác (tạo hai database, giữ một kết nối mở ở cái thứ hai, giết cái thứ nhất, kết nối thứ hai vẫn sống); (c) `killSessions` ném với `master`; (d) rule `sql.query.before` + `when` khớp `insert into` + `nth: 2` + action `killSessions` → lệnh insert thứ hai thất bại, transaction bao quanh rollback (không có dòng nào của transaction đó được ghi), lệnh thứ nhất của transaction đó cũng biến mất; (e) rule `sql.commit.after` + kill → dữ liệu ĐÃ commit vẫn còn dù phía gọi nhận lỗi hoặc không (kiểm tra bằng kết nối mới); (f) `faultyDialect` không có rule nào kích hoạt thì hành vi như không bọc (đọc/ghi/transaction bình thường); (g) `info.name` được truyền đúng.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos sql-faults` → FAIL.
- [ ] **Step 3: Cài đặt.** Dùng truy vấn `sys.dm_exec_sessions` (lọc `database_id = DB_ID(@name)` và `session_id <> @@SPID`, `is_user_process = 1`) rồi `KILL <id>` từng session (SQL động an toàn vì id là số nguyên lấy từ DMV). Chạy `killSessions` bằng một kết nối quản trị riêng (kết nối tới `master` với cùng thông tin đăng nhập `sa`), không dùng pool của hệ thống đang test.
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos sql-faults` hai lần liên tiếp, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/chaos
git commit -m "feat(chaos): SQL Server session kills and fault-injecting dialect wrapper

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Lỗi broker/publisher và proxy HTTP

**Files:**
- Create: `tests/chaos/support/broker-faults.ts`, `http-fault-proxy.ts` và các test `broker-faults.chaos.test.ts`, `http-fault-proxy.chaos.test.ts` (proxy test có thể là `.test.ts` thuần nếu không cần container)

**Interfaces:**
- Consumes: `FaultPlan`; `EventPublisher`/`OutboxMessage`/`PublishOutcome` từ `services/wallet/src/application/ports.ts`; `TestBroker.closeConnections` từ `@billing/testing`.
- Produces:
  ```ts
  // broker-faults.ts
  export function faultyPublisher(plan: FaultPlan): (publisher: EventPublisher) => EventPublisher
  // Bọc publish(message): hit('broker.publish.before', {id, eventType}); gọi publisher thật; hit('broker.publish.after', {id, eventType, outcome});
  // action của rule ở 'before' có thể ném lỗi giả (mất, không publish) — publisher trả { kind: 'failed', error }; ở 'after' có thể ném (publish xong rồi mới báo lỗi → publisher trả { kind: 'failed' } dù message đã tới broker).
  export function dropBrokerConnections(broker: TestBroker, user?: string): Promise<number>   // bọc closeConnections, ghi vào plan khi gọi qua rule
  // http-fault-proxy.ts
  export type ProxyDecision = 'forward' | 'drop' | 'duplicate' | { status: number; body?: unknown } | { delayMs: number }
  export class HttpFaultProxy {
    static start(options: { target: string; plan: FaultPlan; name: string }): Promise<HttpFaultProxy>
    readonly baseUrl: string
    readonly log: ReadonlyArray<{ method: string; url: string; decision: string; status?: number }>
    stop(): Promise<void>
  }
  // Với mỗi request: info = { name, method, url, body, decision: 'forward' }; await plan.hit(`${name}.request`, info); action có thể đặt info.decision.
  // 'drop': đóng socket ngay không phản hồi; 'duplicate': chuyển tiếp HAI lần (trả phản hồi của lần đầu); { status }: trả thẳng không chuyển tiếp; { delayMs }: chờ rồi chuyển tiếp; 'forward': chuyển tiếp nguyên vẹn (giữ header như x-signature, idempotency-key, body gốc dạng byte).
  ```

- [ ] **Step 1: Viết test thất bại.** `faultyPublisher`: dùng publisher giả ghi nhận lời gọi: rule `before` ném → không gọi publisher thật, trả `failed`; rule `after` ném → publisher thật ĐÃ được gọi nhưng kết quả trả về là `failed`; không rule → chuyển tiếp nguyên vẹn. `dropBrokerConnections` (cần broker thật, `.chaos.test.ts`): mở một kết nối, gọi, kết nối bị đóng và số trả về > 0. `HttpFaultProxy` (dựng bằng một HTTP server mục tiêu thật trong test): forward giữ nguyên method/URL/header/body byte-for-byte (kiểm với body có ký tự đặc biệt), `drop` làm client nhận lỗi socket và mục tiêu không nhận request, `duplicate` làm mục tiêu nhận đúng 2 request giống hệt, `{status:503}` trả 503 mà mục tiêu không nhận gì, `{delayMs}` làm chậm đúng khoảng, `stop` đóng sạch (không treo), nhật ký `log` ghi đủ.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos broker-faults http-fault-proxy` (và unit thuần nếu có) → FAIL.
- [ ] **Step 3: Cài đặt** đúng Interfaces (proxy dùng `node:http`; tự chọn cổng tự do bằng `getFreePort` hoặc `listen(0)`).
- [ ] **Step 4: Chạy** các test trên hai lần, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/chaos
git commit -m "feat(chaos): publisher/broker faults and fault-injecting HTTP proxy

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Harness hệ thống trong tiến trình

**Files:**
- Create: `tests/chaos/support/system-harness.ts`, `tests/chaos/support/system-harness.chaos.test.ts`
- Modify: `services/wallet/src/test-support-orders.ts` (chỉ nếu cần bổ sung `received()` cho `OrdersSimulator`; giữ nguyên hành vi hiện có)

**Interfaces:**
- Consumes: Task 2–4 (`FaultPlan`, `OpLog`, `faultyDialect`, `faultyPublisher`, `HttpFaultProxy`, `quiesce`, `killSessions`), `startService` của wallet/payment, mẫu dựng hệ trong `tests/e2e/billing.integration.test.ts` (ĐỌC nó trước và bám sát cách dựng cấu hình wallet/payment).
- Produces:
  ```ts
  export interface SystemOptions { mode?: 'inproc'; seed?: number; tenants?: string[]; workerIntervalMs?: number }   // mode 'child' thêm ở Task 6
  export interface System {
    readonly mode: 'inproc' | 'child'
    readonly seed: number
    readonly plan: FaultPlan                // plan duy nhất; rule phân biệt dịch vụ bằng info.name ('wallet' | 'payment' | 'wallet-to-payment' | 'payment-to-wallet')
    readonly log: OpLog
    readonly walletUrl: string; readonly paymentUrl: string
    readonly walletDb: DatabaseConfig; readonly paymentDb: DatabaseConfig
    readonly walletAdmin: Kysely<unknown>; readonly paymentAdmin: Kysely<unknown>   // kết nối quản trị riêng, KHÔNG bị plan can thiệp
    readonly broker: TestBroker; readonly orders: OrdersSimulator
    readonly proxies: { walletToPayment: HttpFaultProxy; paymentToWallet: HttpFaultProxy }
    openWallet(tenant: string, customer: string, currency?: string): Promise<{ status: number }>
    topup(tenant: string, customer: string, amount: number, key: string): Promise<{ status: number; topupId?: string }>
    sendOrder(input: { tenant: string; customer: string; orderId?: string; amount: number; currency?: string; eventId?: string; correlationId?: string }): Promise<{ orderId: string; eventId: string }>
    ops(tenant: string, route: string, body?: unknown, actor?: string): Promise<{ status: number; body: unknown }>   // gọi /ops/... với x-actor-id (mặc định 'chaos-ops') và x-actor-role: OPS
    restartWallet(): Promise<void>; restartPayment(): Promise<void>   // dừng êm rồi dựng lại trên cùng DB/vhost/cổng
    heal(options?: { timeoutMs?: number }): Promise<void>             // plan.disable(); quiesce các điều kiện chuẩn (xem bên dưới)
    stop(): Promise<void>
  }
  export function createSystem(options?: SystemOptions): Promise<System>
  ```
  Luồng dựng (khớp e2e): tạo hai database test (`createTestDatabase('chaos_wallet'|'chaos_payment')`), migrate/provision, vhost qua `createTestBroker('chaos')`, `OrdersSimulator.connect(broker.ecommerce)`, cổng wallet VÀ payment cấp trước bằng `getFreePort` (để giữ nguyên khi restart và để proxy biết đích), proxy `walletToPayment` (đích = payment) và `paymentToWallet` (đích = wallet) khởi động trước dịch vụ tương ứng; wallet cấu hình `payment.baseUrl = proxy walletToPayment`, payment cấu hình `webhook.url = <proxy paymentToWallet>/webhooks/payment`; wallet và payment dùng `wrapDialect: faultyDialect(plan, { name })` và wallet thêm `wrapPublisher: faultyPublisher(plan)`; `workerIntervalMs` mặc định 50; `retention.enabled` mặc định false (kịch bản retention tự bật bằng cấu hình riêng — thêm tuỳ chọn `retention?: 'off' | { dryRun: boolean; batchSize?: number; days?: ... }`); `reconciliation.autofix` true; backoff topup/webhook ngắn (`[1,2,3]`). `heal()` chờ (qua `quiesce`) tới khi: mọi dòng `outbox` của mọi tenant có `status='SENT'` (không còn PENDING), mọi queue của vhost rỗng (dùng `queueDepth` hiện có), `webhook_events` không còn PENDING, `charges` không còn PENDING, mọi `topups` ở trạng thái cuối (không còn `REQUESTED`/`PENDING`); trước khi chờ phải `plan.disable()` và nếu cần khôi phục (ví dụ dịch vụ đã dừng) thì khởi động lại.

- [ ] **Step 1: Viết test thất bại** (`system-harness.chaos.test.ts`): dựng hệ, mở ví, nạp tiền 100 000 VND qua `topup`, `heal()`, số dư ví = 100 000 và topup `SUCCEEDED` (qua HTTP wallet); `sendOrder` 30 000 với ví đó → "Orders giả" nhận đúng một `OrderPaidV1` (qua `orders.received()`), số dư 70 000; một rule trên proxy `payment-to-wallet` (`{ decision: 'drop' }` lần đầu) làm webhook đầu tiên thất lạc nhưng hệ vẫn hội tụ nhờ gửi lại (topup vẫn `SUCCEEDED` sau `heal`) — chứng minh các điểm gài lỗi thực sự nằm trên đường chạy; `restartWallet()` giữ nguyên dữ liệu và cổng; `ops` gọi được `/ops/actions` (200) và trả 401 khi thiếu role (bằng cách gọi qua `fetch` trực tiếp trong test để thử); `stop()` dọn sạch (database và vhost bị drop, không còn handle mở: kiểm bằng `afterAll` không treo).
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos system-harness` → FAIL.
- [ ] **Step 3: Cài đặt** theo Interfaces. `OrdersSimulator.received()` (nếu thiếu): trả mọi sự kiện kết quả đã nhận (`eventType`, payload đã parse, `messageId`) theo thứ tự nhận; thêm test nhỏ cho nó trong harness test.
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos system-harness` hai lần, `corepack pnpm test:integration wallet payment e2e` (không hỏng gì), `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests services
git commit -m "feat(chaos): in-process system harness with fault hooks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Chế độ tiến trình con và crash thật

**Files:**
- Create: `tests/chaos/support/crash.ts`, `tests/chaos/support/crash.chaos.test.ts`
- Modify: `tests/chaos/support/system-harness.ts` (thêm `mode: 'child'`)

**Interfaces:**
- Consumes: Task 5; `services/wallet/src/main.ts` và `services/payment/src/main.ts` (đọc cấu hình từ biến môi trường: xem `.env.example` của hai dịch vụ cho tên biến).
- Produces:
  ```ts
  export interface ChildService { readonly name: 'wallet' | 'payment'; readonly pid: number; waitReady(timeoutMs?: number): Promise<void>; kill(): Promise<void> /* SIGKILL, đợi tiến trình thoát */; stop(): Promise<void> /* SIGTERM rồi SIGKILL nếu quá hạn */ ; readonly exited: Promise<number | null> }
  export function spawnChildService(input: { name: 'wallet' | 'payment'; env: Record<string, string>; port: number }): Promise<ChildService>
  // SystemOptions.mode = 'child': wallet/payment chạy bằng `node --import tsx <main.ts>` (hoặc cách tương đương đã kiểm chứng trên môi trường này) với env dựng từ cấu hình harness (WALLET_DB_*, WALLET_TENANTS, PAYMENT_BASE_URL=<proxy>, PAYMENT_WEBHOOK_SECRET, RABBITMQ_*, PORT, WORKER_INTERVAL_MS, TOPUP_SUBMIT_BACKOFF, RETENTION_ENABLED=false…; payment: PAYMENT_DB_*, WEBHOOK_URL=<proxy>/webhooks/payment, WEBHOOK_SECRET, PORT, WEBHOOK_BACKOFF, RESPONSE_TIMEOUT_MS…)
  // System (mode 'child') thêm: crashWallet(): Promise<void>; crashPayment(): Promise<void>   // SIGKILL ngay, rồi KHÔNG tự bật lại; restartWallet()/restartPayment() khởi động lại tiến trình con
  ```
  Trong chế độ `child` KHÔNG có `faultyDialect`/`faultyPublisher` (khác tiến trình); các lỗi hỗ trợ: proxy HTTP, `killSessions`, `dropBrokerConnections`, crash/restart. `System.plan` vẫn có (cho proxy). Mọi tiến trình con phải bị giết khi `System.stop()`, và cả khi test thất bại/ngắt giữa chừng (đăng ký dọn ở `process.on('exit')` + hook của harness); đừng để lại tiến trình mồ côi. Dịch vụ phải dùng thông tin đăng nhập `sa` của testcontainers qua env (đây là DB test).

- [ ] **Step 1: Viết test thất bại** (`crash.chaos.test.ts`): `spawnChildService` khởi động wallet con trên DB test đã provision, `waitReady` thành công khi `/health` = 200; `kill()` làm tiến trình thoát ngay (`exited` resolve với `null`/signal) và cổng ngừng nhận kết nối; `System` mode `child` chạy lại luồng cơ bản của Task 5 (mở ví, nạp tiền, gửi order, `heal`) với số dư đúng; `crashWallet()` rồi `restartWallet()` giữ nguyên dữ liệu; `crashPayment()` khi charge đang chờ rồi `restartPayment()` thì topup vẫn hội tụ `SUCCEEDED` sau `heal`; `System.stop()` không để lại tiến trình (kiểm bằng `pid` không còn tồn tại).
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos crash` → FAIL.
- [ ] **Step 3: Cài đặt.** Xác minh cách khởi chạy hoạt động trên Windows (môi trường này) — `process.kill(pid, 'SIGKILL')` kết thúc tiến trình; tránh lớp bọc (`pnpm`/`cmd`) khiến `pid` không phải tiến trình thật. Đọc `main.ts` để biết biến môi trường bắt buộc/tuỳ chọn; thiếu biến thì dịch vụ từ chối chạy (đừng nới `loadConfig`).
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos crash system-harness` hai lần, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests
git commit -m "feat(chaos): child-process mode with SIGKILL crashes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Oracle bất biến 1–4 (sổ cái, không ghi nợ hai lần, nạp tiền khớp payment, outbox)

**Files:**
- Create: `tests/chaos/support/invariants.ts`, `tests/chaos/invariants.chaos.test.ts`

**Interfaces:**
- Consumes: `System` (Task 5/6): `walletAdmin`, `paymentAdmin`, `orders.received()`, tenants.
- Produces:
  ```ts
  export interface Violation { invariant: 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4' | 'INV-5' | 'INV-6' | 'INV-7' | 'INV-8'; message: string; detail?: Record<string, unknown> }
  export class InvariantViolationError extends Error { readonly violations: readonly Violation[] }
  export function collectViolations(system: System, options?: { only?: readonly Violation['invariant'][] }): Promise<Violation[]>
  export function assertSystemInvariants(system: System, options?: { only?: readonly Violation['invariant'][] }): Promise<void>   // ném InvariantViolationError nêu từng bất biến vi phạm + chi tiết (id)
  ```
  Định nghĩa (spec §3), tính trên MỌI tenant của hệ, sau `heal()`:
  - **INV-1:** theo từng tenant: tổng `accounts.balance` = 0; mỗi tài khoản `balance` = tổng `ledger_entries.amount` của nó; mỗi `ledger_transaction` có tổng dòng = 0 (cùng ý với `expectLedgerInvariants` của wallet — dùng lại logic SQL, không import code test của wallet nếu gây vòng phụ thuộc; sao chép có chú thích nguồn).
  - **INV-2:** mỗi `orderId` có tối đa một giao dịch `ORDER_PAYMENT` (nhóm theo business key `order:<id>`) và một dòng `order_payments`; mọi giao dịch `ORDER_PAYMENT` có đúng một dòng `order_payments` khớp `wallet_transaction_id`/số tiền (không mồ côi, không thiếu); mọi `OrderPaidV1` mà "Orders giả" đã nhận cho cùng một order mang cùng `walletTransactionId` và số tiền, và `walletTransactionId` tồn tại trong sổ cái.
  - **INV-3:** mỗi `topups.status='SUCCEEDED'` có đúng một giao dịch `TOPUP` (business key `topup:<id>`) và ngược lại mỗi giao dịch `TOPUP` có topup `SUCCEEDED`; theo tenant+đồng tiền: tổng `TOPUP` trong sổ cái = tổng `charges` `SUCCEEDED` bên payment thuộc tenant đó (xác định tenant của charge bằng cách đã dùng trong đối soát — đọc `reconciliation`/`charges.metadata` để biết cách; nếu khó thì so sánh theo `topups.charge_id` ↔ `charges.id`); mỗi `idempotency_key` bên payment ánh xạ tối đa một charge và mỗi `topups.charge_id` là duy nhất.
  - **INV-4:** mọi `outbox` có `status='SENT'` (không còn `PENDING`); với mỗi `order_payments` có ít nhất một `OrderPaidV1` đã tới "Orders giả" cho order đó; với mỗi lần `PayOrder` bị từ chối đã commit (có `OrderPaymentFailedV1` trong outbox `SENT`) sự kiện đó cũng đã tới "Orders giả"; không có `OrderPaidV1` nào cho order không có `order_payments`.

- [ ] **Step 1: Viết test thất bại** (`invariants.chaos.test.ts`): (a) trên hệ chạy bình thường (mở ví, nạp, trả order, đảo một lần bằng ops, điều chỉnh) `assertSystemInvariants` (chỉ INV-1..4) KHÔNG ném; (b) **test oracle** — với từng bất biến, làm hỏng trạng thái bằng SQL trực tiếp (kết nối quản trị) và xác nhận hàm ném `InvariantViolationError` có `violations` chứa đúng `invariant` mong đợi, rồi hoàn tác (hoặc dùng hệ mới cho mỗi ca): INV-1: `update accounts set balance = balance + 1` trên một ví (tổng ≠ 0 và lệch với dòng); INV-2: chèn một `ledger_transactions` loại `ORDER_PAYMENT` (+ hai dòng cân bằng) không có `order_payments` (mồ côi), và (qua broker/Orders giả hoặc ghi giả vào danh sách nhận) hai `OrderPaidV1` khác `walletTransactionId` cho cùng order; INV-3: đổi một topup `PENDING` thành `SUCCEEDED` không có giao dịch `TOPUP`; chèn thêm một charge `SUCCEEDED` bên payment; INV-4: đặt một dòng outbox `PENDING` không bao giờ gửi, và đặt `SENT` cho dòng `OrderPaidV1` mà Orders giả chưa nhận (chỉ đổi cột `status`); mỗi ca kiểm tra rằng bất biến KHÁC không báo oan khi không liên quan (ví dụ ca INV-3 không kéo theo INV-1 nếu sổ cái vẫn cân). Cố ý làm một ca ghi chú rõ ràng những gì SQL không thể làm hỏng (trigger bất biến chặn sửa ledger) để lý do chọn cách làm hỏng là hợp lệ.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos invariants` → FAIL.
- [ ] **Step 3: Cài đặt** theo định nghĩa; thông báo vi phạm nêu id cụ thể (tenant, orderId, topupId, accountId…); không nuốt lỗi truy vấn (lỗi truy vấn = ném, không coi là "đạt").
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos invariants` hai lần, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests
git commit -m "feat(chaos): invariant oracle for ledger, orders, topups and outbox

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Oracle bất biến 5–8 (đối soát, ops, retention, phục hồi)

**Files:**
- Modify: `tests/chaos/support/invariants.ts`, `tests/chaos/invariants.chaos.test.ts`

**Interfaces:**
- Consumes: Task 7; wallet HTTP đối soát (`POST /reconciliations` với `{date}`, `GET /reconciliations/:id`, `GET /reconciliations/:id/items`), `/ops/actions`, `/health`.
- Produces: bổ sung `collectViolations` cho INV-5..INV-8 (mặc định `only` = tất cả):
  - **INV-5:** với mỗi tenant, chạy đối soát thủ công cho ngày UTC chứa dữ liệu (ngày của `system.clock` hiện tại, hoặc ngày của các `topups.completed_at`/`created_at`; dùng `options.reconcileDays?: string[]`, mặc định hôm nay UTC); chờ lượt `COMPLETED`; không có item `OPEN` loại `LEDGER_UNBALANCED` hoặc `BALANCE_MISMATCH`; item loại thiếu phía wallet (autofix) phải ở trạng thái đã ghi bù (không còn `OPEN`); chạy lại một lượt nữa → 0 item mới (hội tụ). Đối soát không được biến đổi sổ cái trừ ghi bù đúng quy tắc (kiểm INV-1 lại sau đó).
  - **INV-6:** mỗi `ops_actions` có hiệu ứng tương ứng theo loại (`ADJUST` → giao dịch `ADJUSTMENT` có `business_key = adjustment:<id>`; `REVERSE` → giao dịch `REVERSAL` mà `reverses_transaction_id` khớp `target`; `FREEZE`/`UNFREEZE` → trạng thái `accounts.frozen_at` khớp với hành động cuối cùng của ví đó) và ngược lại mọi giao dịch `ADJUSTMENT`/`REVERSAL` có đúng một `ops_actions` (không hiệu ứng mồ côi); không có hai `ops_actions` cho cùng một khóa idempotency (ràng buộc unique sẵn có — kiểm tra ở mức dữ liệu).
  - **INV-7:** không có kiểm tra riêng; ghi chú: khi retention chạy chế độ thật trong lúc có lỗi thì INV-1..4 và INV-6 vẫn phải đúng (các kịch bản S12/soak gọi oracle sau retention). Bổ sung kiểm tra "retention không xóa dòng sống": không còn `outbox PENDING` bị mất so với dòng đã tạo — dùng bộ đếm do harness ghi (`System.expectations`: số order đã trả, số topup đã tạo) để so với số dòng `order_payments`/`topups` còn lại (retention không động tới các bảng này).
  - **INV-8:** `GET /health` của wallet và payment = 200; một truy vấn đơn giản qua pool của mỗi dịch vụ thành công (gọi một endpoint đọc nhẹ như `GET /wallet/entries` hoặc tương đương đã có); mọi kết nối dịch vụ không treo (timeout 10 s).
  Thêm vào `System` các bộ đếm kỳ vọng do harness tự cập nhật: `expectations: { ordersPaid: Set<string>; topupsCreated: Set<string>; opsActions: number }` (mỗi lần `sendOrder`/`topup`/`ops` thành công về phía client thì ghi nhận). Nếu client nhận lỗi thì KHÔNG ghi (kết quả không xác định) — oracle chỉ yêu cầu "mọi thứ đã xác nhận thành công phải còn đủ".

- [ ] **Step 1: Viết test thất bại**: (a) hệ chạy bình thường qua đủ INV-1..8 không ném (bao gồm một đối soát thật với `FakeSettlement`? — KHÔNG: dùng settlement thật từ payment qua `GET /settlements` của payment, vì hệ có payment thật); (b) test oracle cho INV-5: tạo thủ công một charge `SUCCEEDED` bên payment không có topup tương ứng ở wallet (hoặc xoá/đổi dữ liệu để wallet thiếu một khoản nạp) → với `autofix` TẮT (tuỳ chọn harness `reconciliation: { autofix: false }`) oracle phải báo INV-5 (item `OPEN`); với autofix BẬT oracle ghi bù và KHÔNG báo lỗi (hội tụ); INV-6: chèn giao dịch `ADJUSTMENT` không có `ops_actions` → báo; xoá bằng cách đặt `frozen_at` trái với dòng `ops_actions` cuối → báo; INV-7: xoá một dòng `order_payments` đã được ghi nhận trong `expectations` → báo; INV-8: dừng hẳn wallet (không khởi động lại) → báo health. Mỗi ca xác nhận bất biến khác không báo oan.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos invariants` → FAIL.
- [ ] **Step 3: Cài đặt**; thêm `expectations` và tuỳ chọn `reconciliation` vào harness (tùy chọn mặc định giữ nguyên hành vi Task 5).
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos invariants system-harness crash` hai lần, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests
git commit -m "feat(chaos): invariant oracle for reconciliation, ops, retention and recovery

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Kịch bản S1–S5 (SQL Server và RabbitMQ)

**Files:**
- Create: `tests/chaos/scenarios-sql-broker.chaos.test.ts`

**Interfaces:**
- Consumes: `createSystem` (mode `inproc`), `FaultPlan` rule, `killSessions`, `dropBrokerConnections`, `assertSystemInvariants`, `System.heal`, `System.orders.received()`.

Mỗi kịch bản: dựng hệ mới (hoặc dùng chung một hệ cho cả file và reset bằng khách/đơn mới — chọn cách ổn định nhất, nhưng KHÔNG để lỗi của kịch bản này rò sang kịch bản sau), nạp sẵn một ví có tiền (nạp tiền bình thường trước khi bật lỗi), thêm rule lỗi, thực hiện hành động, `heal()`, rồi `assertSystemInvariants(system)` + kiểm tra riêng. Khi một kịch bản thất bại phải ghi seed/nhật ký vào `tests/chaos/.out/` (hook `afterEach` dùng `ctx.task.result?.state`).

- [ ] **Step 1: Viết test thất bại/chưa có** cho 5 kịch bản (mỗi kịch bản một `it`):
  - **S1 — KILL giữa `PayOrder`, trước commit:** rule `sql.query.before` (`info.name === 'wallet'`, `when` SQL chứa `insert into` bảng `order_payments`, `nth: 1`) → `killSessions(system.walletDb)`. `sendOrder` 30 000 cho ví 100 000. Kỳ vọng: lần đầu không để lại ghi nợ (kiểm tra ngay khi quan sát được: không có `order_payments`); broker giao lại tin nhắn (nack/retry theo cơ chế consumer hiện có) → sau `heal`: đúng một giao dịch `ORDER_PAYMENT`, ví 70 000, đúng một `OrderPaidV1` tới Orders giả (hoặc nhiều bản cùng nội dung — theo INV-2/INV-4), invariants đạt.
  - **S2 — KILL ngay sau commit, trước ack:** rule `sql.commit.after` (wallet) sau khi lệnh `insert` vào `order_payments` đã chạy (dùng cờ `armed` do rule `sql.query.after` đặt, vì commit không mang SQL) → `killSessions`. Kỳ vọng: broker giao lại; lần giao lại ra `REPLAYED` (không ghi nợ lần hai); ví bị trừ đúng một lần; outbox đủ; invariants đạt.
  - **S3 — consumer chết trước ack, giao lại nhiều lần:** dùng hook consumer (`afterOrderHandled` qua tuỳ chọn harness `afterOrderHandled`; thêm vào `createSystem` nếu thiếu) ném lỗi 3 lần liên tiếp cho cùng order; kỳ vọng hội tụ về một khoản trả, không dead-letter nếu số lần giao lại nằm trong cấu hình `retryDelaysSeconds` (xác nhận hành vi thực tế của consumer/dead-letter và ghi lại trong test).
  - **S4 — mất kết nối broker khi relay vừa publish xong, chưa `markSent`:** rule `broker.publish.after` (ném lỗi giả, `nth: 1`) → publisher trả `failed` dù message đã tới broker; relay thử lại. Kỳ vọng: Orders giả nhận `OrderPaidV1` ≥ 1 lần, mọi bản trùng cùng `eventId` và cùng payload; không mất; outbox cuối cùng `SENT`; invariants đạt.
  - **S5 — mất kết nối broker khi đang consume:** gửi 10 order liên tiếp, giữa chừng gọi `dropBrokerConnections` (user `billing_wallet`) hai lần; kỳ vọng client tự nối lại, cả 10 order được trả đúng một lần (10 `order_payments`), không mất message; invariants đạt.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos scenarios-sql-broker` → FAIL/chưa có hành vi mong đợi.
- [ ] **Step 3: Hiện thực** (bổ sung harness nếu cần: `afterOrderHandled`, các hàm đợi tiện ích). **Nếu kịch bản làm lộ lỗi thật** (ví dụ pool không hồi phục, mất message, ghi nợ hai lần): áp dụng chính sách lỗi trong Global Constraints — lỗi nhỏ: commit sửa RIÊNG kèm test; lỗi lớn: mục trong `docs/ops/chaos-findings.vi.md` + `it.fails` tham chiếu mục đó + báo ngay.
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos scenarios-sql-broker` HAI lần liên tiếp (phát hiện test chập chờn), `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit** (và commit sửa lỗi riêng nếu có)

```bash
git add tests
git commit -m "test(chaos): SQL Server and RabbitMQ failure scenarios S1-S5

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Kịch bản S6–S10 (payment, webhook và crash thật)

**Files:**
- Create: `tests/chaos/scenarios-payment-crash.chaos.test.ts`

**Interfaces:**
- Consumes: proxy `walletToPayment`/`paymentToWallet` (rule trên điểm `<name>.request` đặt `info.decision`), `createSystem` mode `inproc` (S6–S8) và `child` (S9–S10), `crashWallet/crashPayment/restart*`, `heal`, oracle.

- [ ] **Step 1: Viết test** cho 5 kịch bản:
  - **S6 — payment 5xx/timeout khi tạo charge:** rule trên `wallet-to-payment.request` (`url` chứa `/charges`): lần 1 `{status: 503}`, lần 2 `{delayMs}` dài hơn `PAYMENT_TIMEOUT_MS`; nạp tiền 50 000. Kỳ vọng: topup được thử lại theo backoff, cuối cùng `SUCCEEDED`, tối đa một charge cho khóa idempotency (kiểm trên payment DB), ví +50 000 đúng một lần; invariants đạt.
  - **S7 — webhook thất lạc → đối soát ghi bù:** rule `payment-to-wallet.request` → `drop` MỌI webhook (`times` không giới hạn) trong lúc nạp 40 000; cho `webhook backoff` hết số lần/để charge `SUCCEEDED` bên payment; sau đó gỡ lỗi và chạy đối soát thủ công (autofix bật) qua HTTP; kỳ vọng ví được ghi có ĐÚNG MỘT lần (từ đối soát hoặc từ webhook gửi lại — chấp nhận cả hai, nhưng không hai lần), item đối soát `AUTO_APPLIED`/đã giải quyết nếu đi đường đối soát; invariants đạt (INV-3, INV-5).
  - **S8 — webhook trùng và đến muộn sau khi đối soát đã ghi bù:** rule `payment-to-wallet.request` → `duplicate` cho mọi webhook; thêm kịch bản phụ: giữ webhook (`delayMs` lớn), cho đối soát ghi bù trước, rồi webhook đến muộn; kỳ vọng ví chỉ được ghi có một lần, không lỗi 5xx cho webhook trùng (đáp 200/2xx idempotent), invariants đạt.
  - **S9 — `SIGKILL` wallet khi đang submit topup (mode `child`):** rule trên proxy `wallet-to-payment.request` đặt `decision: 'forward'` rồi `crashWallet()` NGAY sau khi payment đã nhận request tạo charge nhưng trước khi wallet kịp lưu `charge_id` (dùng rule sau khi proxy trả phản hồi: hook `<name>.response` nếu thêm vào proxy — nếu proxy thiếu điểm này thì bổ sung trong Task này kèm test, giữ tương thích); `restartWallet()`; kỳ vọng worker submit lại cùng khóa idempotency, payment tạo ĐÚNG MỘT charge, topup hội tụ `SUCCEEDED`, ví +amount một lần; invariants đạt.
  - **S10 — `SIGKILL` payment sau khi tạo charge, trước webhook (mode `child`):** `crashPayment()` ngay khi charge đã `SUCCEEDED` nhưng chưa có webhook nào được giao (đặt rule `drop` cho webhook đầu tiên hoặc chặn bằng `delayMs`); `restartPayment()`; kỳ vọng worker giao webhook sau khi khởi động lại (hàng đợi trong DB), ví được ghi có một lần; invariants đạt.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos scenarios-payment-crash` → FAIL.
- [ ] **Step 3: Hiện thực** (bổ sung điểm `<name>.response` cho proxy nếu cần, kèm test; tinh chỉnh cấu hình harness cho backoff/timeout ngắn). Lỗi thật tìm thấy → chính sách lỗi như Task 9.
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos scenarios-payment-crash http-fault-proxy` HAI lần liên tiếp, `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests
git commit -m "test(chaos): payment, webhook and crash scenarios S6-S10

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Kịch bản S11–S13 (ops, retention, phục hồi pool) và bài soak

**Files:**
- Create: `tests/chaos/scenarios-ops-retention.chaos.test.ts`, `tests/chaos/soak.chaos.test.ts`, `tests/chaos/support/soak.ts` (bộ sinh tải và lịch lỗi)

**Interfaces:**
- Consumes: mọi thứ ở trên; `resolveSeed`, `createPrng`, `OpLog.writeTo`, `System` ở cả hai chế độ (`CHAOS_MODE=inproc|child|mixed`, mặc định `mixed`: vòng lẻ `inproc`, vòng chẵn `child`).
- Produces: `runSoakRound(input: { system: System; prng: Prng; durationMs: number; mode: 'inproc' | 'child' }): Promise<void>` — sinh tải và lịch lỗi trong `durationMs` rồi trả về (chưa `heal`/oracle; test gọi sau).

- [ ] **Step 1: Viết test** cho S11–S13 và soak:
  - **S11 — KILL giữa thao tác ops:** với `AdjustWallet`, `ReverseTransaction`, `FreezeWallet`: rule `sql.query.before` (wallet) khớp `insert into` bảng `ops_actions` hoặc `ledger_entries` (nth 1) → `killSessions`; gọi `ops(...)` (có thể nhận lỗi); thử lại CÙNG `idempotencyKey` sau khi gỡ lỗi; kỳ vọng thử lại trả kết quả hợp lệ (cùng kết quả nếu lần đầu đã commit, hoặc thực hiện lần đầu nếu rollback), không có `ops_actions` mồ côi hay hiệu ứng mồ côi (INV-6), ví/số dư đúng (INV-1); cho cả ba loại thao tác.
  - **S12 — retention thật bị cắt giữa lô:** cấu hình retention `{ dryRun: false, batchSize: 5 }` với dữ liệu đủ cũ (đặt `created_at`/`sent_at` cũ bằng SQL quản trị cho các dòng `outbox SENT`, `processed_messages`, `idempotency_keys` với số lượng > nhiều lô); rule `sql.query.before` khớp `delete top` (wallet) `nth: 2` → `killSessions`; kỳ vọng lượt chạy lỗi không xoá dòng sống (INV-1..4, INV-6, INV-7 đạt ngay sau lỗi), lượt retention kế tiếp dọn xong phần còn lại, các bảng tài chính không đổi.
  - **S13 — KILL toàn bộ session khi service rảnh:** sau khi hệ rảnh, `killSessions(walletDb)` và `killSessions(paymentDb)`; kỳ vọng request kế tiếp tới mỗi dịch vụ (đọc ví; tạo charge qua nạp tiền) thành công (có thể sau tối đa một lần thử lại phía client — ghi lại hành vi) và INV-8 đạt. Nếu pool KHÔNG hồi phục: lỗi thật → chính sách lỗi.
  - **Soak (`soak.chaos.test.ts`):** `it('keeps every invariant under random failures', ...)`: `seed = resolveSeed(process.env)` (in ra bằng `console.info` một dòng `chaos seed=<n> rounds=<m> mode=<mode>`), cho từng vòng `CHAOS_ROUNDS` (mặc định 3): tạo hệ, `runSoakRound` trong `CHAOS_MAX_SECONDS` (mặc định 30), `heal`, `assertSystemInvariants`, `system.stop()`. `runSoakRound`: khoảng 8 luồng song song (mỗi luồng chọn thao tác theo prng: nạp tiền (HTTP), `sendOrder`, ops adjust/reverse/freeze/unfreeze/replay (chỉ trên order đã trả/ví tồn tại), đọc ví, chạy retention (bật/tắt theo prng), thao tác đối soát thủ công), và một luồng "lịch lỗi" thêm các rule hoặc thực thi lỗi theo thời gian từ prng fork riêng: `inproc`: KILL SQL (qua rule xác suất nhỏ trên `sql.query.before`), publish trùng/mất (`broker.publish.*`), đóng kết nối broker, proxy 5xx/chậm/drop/duplicate, `restartWallet/restartPayment` êm; `child`: `killSessions` theo thời gian, `dropBrokerConnections`, proxy faults, `crashWallet/crashPayment` rồi `restart*`. Mọi hành động (cả tải lẫn lỗi) ghi vào `OpLog`. Khi vòng thất bại (oracle ném hoặc lỗi khác): `log.writeTo('tests/chaos/.out', 'soak-<seed>-round<k>')`, in đường dẫn và cách chạy lại (`CHAOS_SEED=<seed> CHAOS_ROUNDS=<k> corepack pnpm test:chaos soak`), rồi ném lại lỗi. Thao tác client nhận lỗi (do lỗi gài) KHÔNG được coi là thất bại của test; chỉ oracle sau `heal` quyết định.
  - **Meta-test cho soak:** một test nhanh (độ dài 3 giây, 1 vòng, seed cố định) chứng minh bài chạy được đầu-cuối và cùng seed cho cùng chuỗi hành động LÊN KẾ HOẠCH (so sánh phần "lịch lỗi" và chuỗi lựa chọn thao tác sinh từ prng, không so thứ tự đan xen thực tế) ở hai lần chạy.
- [ ] **Step 2: Chạy** `corepack pnpm test:chaos scenarios-ops-retention soak` → FAIL.
- [ ] **Step 3: Hiện thực.** Điều chỉnh độ dài mặc định để TOÀN BỘ `corepack pnpm test:chaos` chạy dưới khoảng 10 phút trên máy phát triển (ghi thời gian thực tế trong báo cáo). Lỗi thật → chính sách lỗi; nếu soak tìm thấy lỗi khó tái hiện, lưu seed và nhật ký vào `chaos-findings.vi.md`.
- [ ] **Step 4: Chạy** `corepack pnpm test:chaos` (toàn bộ) HAI lần, riêng `soak` với hai seed cố định khác nhau (`CHAOS_SEED=1`, `CHAOS_SEED=2`), `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS (hoặc `it.fails` có tham chiếu cho lỗi lớn đã ghi nhận).
- [ ] **Step 5: Commit**

```bash
git add tests
git commit -m "test(chaos): ops, retention and pool recovery scenarios plus seeded soak

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Tài liệu

**Files:**
- Create: `docs/ops/chaos-testing.vi.md`, `docs/adr/0014-chaos-tests-in-process-and-child.vi.md`, `docs/ops/chaos-findings.vi.md` (chỉ nếu có phát hiện chưa sửa; nếu không có phát hiện lớn thì tạo tệp ngắn ghi "không có phát hiện chưa xử lý" và liệt kê các lỗi đã tìm thấy + đã sửa kèm commit)
- Modify: `docs/superpowers/specs/2026-10-12-chaos-tests-design.md` (trạng thái "Đã triển khai"; sửa `dbPlugins` thành `wrapDialect` và các điểm khác code lệch thiết kế), `README.md` (mục ngắn "Chaos test"), `docs/ops/local-stack.vi.md` hoặc tài liệu liên quan nếu có chỗ nói về cách chạy test

Toàn bộ văn bản tiếng Việt, giọng như `docs/ops/retention.vi.md` và ADR-0010..0013. ĐỌC code trước khi viết (`tests/chaos/**`, `vitest.chaos.config.ts`, hai seam production); không bịa hành vi; kiểm mọi lệnh, biến môi trường, đường dẫn.

- [ ] **Step 1: `docs/ops/chaos-testing.vi.md`** gồm: mục đích và cam kết được kiểm tra (8 bất biến); cách chạy (`corepack pnpm test:chaos`, chạy một kịch bản, `CHAOS_SEED`, `CHAOS_ROUNDS`, `CHAOS_MAX_SECONDS`, `CHAOS_MODE`), thời gian chạy điển hình; yêu cầu (Docker cho testcontainers; KHÔNG dùng stack `billing-local`); kiến trúc công cụ (FaultPlan, bọc dialect, proxy, publisher, tiến trình con); bảng 13 kịch bản (điểm lỗi, kỳ vọng, bất biến liên quan); bài soak và cách tái hiện từ seed + nhật ký trong `tests/chaos/.out/` (nói rõ giới hạn: thứ tự đan xen có thể khác); cách thêm điểm lỗi/kịch bản mới; giới hạn (không phải test hạ tầng thật, không phủ phía Orders C#, chế độ child không có lỗi dialect/publisher); xử lý sự cố test chập chờn.
- [ ] **Step 2: ADR-0014** (Trạng thái / Bối cảnh / Quyết định / Phương án đã loại / Hệ quả): quyết định — lệnh riêng, trong tiến trình + tiến trình con, bọc dialect thay cho plugin, oracle bất biến chung có test riêng, kịch bản xác định + soak theo seed, chính sách lỗi tìm thấy; đã loại — Toxiproxy, pause/stop container, gộp vào `test:integration`, plugin Kysely; hệ quả — hai seam production chỉ dùng cho test, thời gian CI riêng, cần Docker, tái hiện không tuyệt đối.
- [ ] **Step 3: `chaos-findings.vi.md` và cập nhật** các tệp còn lại ở danh sách Files; thêm vào README liên kết tới `chaos-testing.vi.md` và ADR-0014.
- [ ] **Step 4: Kiểm và commit.** `corepack pnpm exec prettier --write` chỉ các tệp đã sửa; `corepack pnpm format:check`, `corepack pnpm exec vitest run tools/kibana/docs.test.ts`, `corepack pnpm test` (bài kiểm tra tài liệu bàn giao phải còn đạt), `corepack pnpm lint`.

```bash
git add docs README.md
git commit -m "docs: chaos testing guide, ADR-0014 and findings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Cổng cuối

- [ ] **Step 1: Chạy tất cả — TUẦN TỰ, không chạy hai lượt nặng song song (SQL Server dễ quá tải)**

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm format:check
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:contract
corepack pnpm test:chaos
docker compose -f deploy/compose.local.yml --env-file deploy/.env config -q
corepack pnpm kibana:build -- --defaults-only && git diff --stat -- deploy/kibana
```

Kỳ vọng: tất cả xanh (baseline trước tính năng: 844 unit, 609 integration, 2 contract; số mới cao hơn; `test:chaos` thêm: nêu số test và thời gian); `compose config -q` thoát 0; `kibana:build --defaults-only` không để lại diff. Nếu `test:integration` có tệp lỗi `beforeAll` do timeout SQL Server thì chạy riêng các tệp đó và báo cả hai kết quả. Không dừng hay sửa stack local.

- [ ] **Step 2: Dọn dẹp** — `git status --short` sạch (không có `deploy/.env`, `params.local.json`, `tests/chaos/.out/`); `git diff main..HEAD -- . ':!docs' ':!*.ndjson' | grep -nE "^\+.*(console\.log|\.only\(|TODO|FIXME|debugger)"` → chỉ dòng in seed có chủ đích trong `tests/chaos/soak.chaos.test.ts`; không bí mật; không còn tiến trình `tsx`/node mồ côi do chaos test (`Get-Process`/`tasklist` — chỉ BÁO, không kill tiến trình khác).
- [ ] **Step 3: Báo cáo** — danh sách commit (`git log --oneline main..HEAD`), kết quả từng lệnh, thời gian `test:chaos`, danh sách lỗi thật chaos tìm thấy (đã sửa / ghi nhận), và hai lần chạy soak với hai seed. KHÔNG push hay merge.

---

## Self-Review (đã thực hiện)

- **Phủ spec:** quyết định 1–6 → Task 1 (seam, cấu hình, lệnh riêng), 3–6 (công cụ), 9–11 (kịch bản/soak), Global Constraints (chính sách lỗi). Công cụ §2 → Task 2–6; bất biến §3 → Task 7–8; 13 kịch bản §4 → Task 9–11 (S1–S5, S6–S10, S11–S13); soak §5 → Task 11; kiểm thử công cụ §6 → test đi kèm từng task + test oracle (Task 7–8); tài liệu §7 → Task 12; rủi ro §8 → Global Constraints (chờ theo điều kiện, KILL chỉ DB test, dọn tiến trình) và Task 6/13.
- **Chữ ký nhất quán:** `FaultPlan.hit/add`, `faultyDialect(plan, {name})`, `faultyPublisher(plan)`, `HttpFaultProxy`, `System`/`createSystem`, `collectViolations/assertSystemInvariants` được định nghĩa một lần (Task 2–8) và dùng đúng tên ở Task 9–11. Điểm lệch có chủ đích so với spec (bọc dialect thay `dbPlugins`; soak xen kẽ hai chế độ) được ghi ở Global Constraints và sửa trong spec ở Task 12.
- **Điểm implementer phải tự xác minh bằng đọc code:** cách `OrdersSimulator` ghi nhận sự kiện và cách thêm `received()` (Task 5); cách xác định tenant của charge bên payment cho INV-3 (Task 7); hành vi dead-letter/retry thực tế của consumer (S3); cách chạy `main.ts` bằng tsx trên Windows (Task 6); tên điểm lỗi proxy `<name>.response` (S9).
