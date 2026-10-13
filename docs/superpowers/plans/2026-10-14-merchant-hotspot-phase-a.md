# Merchant Hotspot — Phase A (benchmark and baseline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bộ đo tải tái lập được (`corepack pnpm test:perf`) cho điểm nóng tài khoản MERCHANT (và GATEWAY), chạy đo trần hiện tại, commit baseline và báo cáo phân tích; dừng để người dùng chốt ngưỡng trước Pha B.

**Architecture:** Thư mục `tests/perf/` với cấu hình vitest riêng. Lõi thuần (histogram, thống kê, báo cáo, cấu hình môi trường), vòng tải kín N luồng, lấy mẫu chờ khóa của SQL Server (`sys.dm_os_wait_stats` và request đang bị chặn), môi trường đo mức use case (SQL Server thật qua testcontainers, đồng hồ và id thật), ba kịch bản use case, một kịch bản đầu-cuối dùng lại harness chaos. Không đổi code production.

**Tech Stack:** TypeScript, vitest, testcontainers (SQL Server 2022 + RabbitMQ), Kysely/tedious, `corepack pnpm`.

## Global Constraints

Spec: `docs/superpowers/specs/2026-10-14-merchant-hotspot-design.md` (đọc trước khi làm bất kỳ task nào).

- Chạy lệnh bằng `corepack pnpm`. Không push/merge. Không commit `deploy/.env`, `deploy/kibana/params.local.json`, `tests/perf/.out/`. Không ghi bí mật vào log/commit. KHÔNG `docker compose down`; KHÔNG đụng stack `billing-local` (các container `billing-local-*` có thể đang dừng — để nguyên); bộ đo chỉ dùng testcontainers.
- **Pha A KHÔNG đổi code production** (`services/**`, `packages/**`, `db/**`): chỉ thêm `tests/perf/**`, cấu hình, script, tài liệu. Nếu thấy cần đổi code production thì dừng và báo (BLOCKED).
- Comment trong code bằng tiếng Việt (như code xung quanh); tên test bằng tiếng Anh. Không thêm thư viện production; dev-dependency chỉ khi thật cần và nêu rõ.
- Lệnh `test:perf` → `vitest run --config vitest.perf.config.ts`; include `tests/perf/**/*.perf.test.ts`; `globalSetup` dùng lại `./packages/testing/src/containers.global-setup.ts`; `fileParallelism: false`; `testTimeout` rất lớn (≥ 3 600 000 ms); `silent: false`. `vitest.config.ts` (chạy `corepack pnpm test`) và `vitest.integration.config.ts` KHÔNG được lấy tệp `*.perf.test.ts` (thêm vào `exclude` của `vitest.config.ts`); các test thuần `tests/perf/support/*.test.ts` chạy cùng `corepack pnpm test`.
- Biến môi trường (đọc và kiểm tra ở MỘT chỗ, `tests/perf/support/config.ts`; giá trị sai phải ném lỗi rõ): `PERF_CONCURRENCY` (danh sách số nguyên dương, mặc định `1,4,16,64`), `PERF_DURATION_SECONDS` (mặc định 20), `PERF_WARMUP_SECONDS` (mặc định 3), `PERF_REPEATS` (mặc định 3), `PERF_CUSTOMERS` (mặc định 2000), `PERF_TENANTS` (mặc định 1), `PERF_E2E_ORDERS` (mặc định 200), `PERF_E2E_CONCURRENCY` (mặc định 16), `PERF_MACHINE` (nhãn máy, mặc định tên host), `PERF_OUT` (mặc định `tests/perf/.out`), `PERF_SCENARIOS` (lọc theo tên, mặc định tất cả).
- Báo cáo JSON có `schemaVersion: 1`; baseline commit nằm trong `docs/perf/` (không phải `.out`).
- **Kiểm đúng đắn từng lượt đo:** mức use case không dựng được `System` nên dùng kiểm tra riêng (`validity.ts`): bất biến sổ cái (tổng số dư mọi tài khoản = 0; mỗi số dư = tổng dòng sổ cái; mỗi giao dịch cân bằng) và đối chiếu số đếm (số thanh toán PAID = số dòng `order_payments` mới = số giao dịch `ORDER_PAYMENT` mới; tương tự nạp tiền với `TOPUP`). Mức đầu-cuối dùng `assertSystemInvariants` đầy đủ của chaos. Lượt đo vi phạm → kết quả KHÔNG hợp lệ (test thất bại, không ghi vào baseline).
- Không dùng `sleep` cố định để quyết định đạt/không đạt; chờ theo điều kiện có timeout. Mọi tài nguyên (DB, vhost, kết nối, dịch vụ) phải được dọn kể cả khi test thất bại.
- Số đo nhiễu: không đặt ngưỡng tuyệt đối về thông lượng/độ trễ trong test (không cổng CI); test chỉ khẳng định tính đúng đắn và hình dạng báo cáo.
- Baseline trước tính năng: 938 unit, 609 integration, 2 contract; số mới phải cao hơn; `test:integration` không đổi.

---

## File Structure

| Tệp | Vai trò |
|---|---|
| `vitest.perf.config.ts`, `package.json` (`test:perf`), `.gitignore`, `vitest.config.ts` | cấu hình chạy |
| `tests/perf/support/{config,histogram,stats,machine,report}.ts` (+ test thuần) | lõi thuần |
| `tests/perf/support/load-driver.ts` | vòng tải kín |
| `tests/perf/support/wait-stats.ts` | hiệu `sys.dm_os_wait_stats` + lấy mẫu request bị chặn |
| `tests/perf/support/perf-env.ts`, `seed.ts`, `validity.ts` | môi trường đo mức use case, dựng dữ liệu, kiểm đúng đắn |
| `tests/perf/scenarios/*.perf.test.ts` | các kịch bản đo |
| `docs/perf/**` | baseline và báo cáo phân tích |

---

### Task 1: Cấu hình chạy `test:perf` và khung thư mục

**Files:**
- Create: `vitest.perf.config.ts`, `tests/perf/support/config.ts`, `tests/perf/support/config.test.ts`, `tests/perf/smoke.perf.test.ts`
- Modify: `package.json` (script `test:perf`), `.gitignore` (`/tests/perf/.out/`), `vitest.config.ts` (exclude `**/*.perf.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export interface PerfConfig {
    concurrency: readonly number[]; durationSeconds: number; warmupSeconds: number; repeats: number
    customers: number; tenants: number; e2eOrders: number; e2eConcurrency: number
    machine: string; out: string; scenarios: readonly string[] | null
  }
  export function loadPerfConfig(env: NodeJS.ProcessEnv): PerfConfig   // mặc định/kiểm tra theo Global Constraints; giá trị sai ném Error nêu tên biến
  ```

- [ ] **Step 1: Viết test thất bại** `config.test.ts`: mặc định đúng; từng biến hợp lệ được đọc; biến sai (không phải số nguyên dương, danh sách rỗng, `PERF_REPEATS=0`, `PERF_CONCURRENCY=1,x`) ném lỗi nêu tên biến; `PERF_SCENARIOS` tách theo dấu phẩy. `smoke.perf.test.ts`: một test chạy được dưới cấu hình mới, thấy `inject('sqlServer')`, tạo rồi drop một database (mẫu `tests/chaos/support/harness.smoke.chaos.test.ts`).
- [ ] **Step 2: Chạy** `corepack pnpm exec vitest run tests/perf/support/config.test.ts` → FAIL.
- [ ] **Step 3: Cài đặt** cấu hình, script, `.gitignore`, exclude; kiểm `corepack pnpm test` KHÔNG chạy `*.perf.test.ts` và vẫn chạy `config.test.ts`.
- [ ] **Step 4: Chạy** `corepack pnpm exec vitest run tests/perf/support`, `corepack pnpm test:perf` (smoke), `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` → PASS.
- [ ] **Step 5: Commit**

```bash
git add vitest.perf.config.ts package.json .gitignore vitest.config.ts tests/perf
git commit -m "feat(perf): test:perf runner config and PERF_* environment parsing

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Lõi thuần — histogram, thống kê, thông tin máy, báo cáo

**Files:**
- Create: `tests/perf/support/{histogram,stats,machine,report}.ts` và các test thuần `*.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // histogram.ts
  export function percentile(sortedOrUnsorted: readonly number[], p: number): number   // p ∈ [0,100], nội suy kiểu "nearest-rank"; mảng rỗng → NaN; không sửa mảng đầu vào
  export interface LatencySummary { count: number; mean: number; p50: number; p95: number; p99: number; max: number }
  export function summarizeLatencies(latenciesMs: readonly number[]): LatencySummary
  // stats.ts
  export function median(values: readonly number[]): number
  export function range(values: readonly number[]): { min: number; max: number }
  // machine.ts
  export interface MachineInfo { label: string; cpus: number; memoryGb: number; node: string; os: string; sqlServerVersion: string | null; gitSha: string | null }
  export function describeMachine(input: { label: string; sqlServerVersion?: string | null }): MachineInfo   // gitSha từ `git rev-parse HEAD` (null nếu lỗi)
  // report.ts
  export interface RepeatResult { throughputPerSec: number; ok: number; errors: { deadlock: number; timeout: number; other: number }; latency: LatencySummary; waits: Record<string, { waitMs: number; count: number }>; blocked: BlockedSummary[] }
  export interface BlockedSummary { waitType: string; statement: string; count: number }
  export interface LevelResult { concurrency: number; repeats: RepeatResult[]; medianThroughputPerSec: number; throughputRange: { min: number; max: number }; medianP95Ms: number; medianP99Ms: number }
  export interface ScenarioResult { name: string; description: string; levels: LevelResult[] }
  export interface PerfReport { schemaVersion: 1; createdAt: string; machine: MachineInfo; config: Record<string, unknown>; scenarios: ScenarioResult[]; e2e?: E2eResult; valid: boolean; notes: string[] }
  export interface E2eResult { orders: number; concurrency: number; throughputPerSec: number; p50Ms: number; p95Ms: number; p99Ms: number; invariantsOk: boolean }
  export function buildLevelResult(concurrency: number, repeats: RepeatResult[]): LevelResult
  export function writeReport(report: PerfReport, dir: string, name: string): Promise<{ json: string; markdown: string }>   // ghi <name>.json và <name>.md (bảng thông lượng/p95/p99 theo mức đồng thời cho từng kịch bản; mục chờ khóa nổi bật; mục e2e)
  export function renderMarkdown(report: PerfReport): string
  ```

- [ ] **Step 1: Viết test thất bại**: `percentile` với mẫu biết trước (ví dụ 1..100 → p50=50, p95=95, p99=99; một phần tử; rỗng → NaN; không thay đổi mảng gốc; p ngoài [0,100] ném lỗi); `summarizeLatencies` đúng mean/max/count; `median` chẵn/lẻ và rỗng; `range`; `describeMachine` trả cpus>0, memory>0, node khớp `process.version`; `buildLevelResult` lấy trung vị thông lượng, min/max, trung vị p95/p99 qua các lần lặp; `renderMarkdown` chứa tên kịch bản, các mức đồng thời và số (kiểm bằng so khớp chuỗi chính xác trên một báo cáo mẫu cố định, snapshot viết tay trong test, không dùng snapshot tự sinh); `writeReport` tạo cả hai tệp trong thư mục tạm, JSON đọc lại bằng `JSON.parse` và `schemaVersion === 1`.
- [ ] **Step 2: Chạy** `corepack pnpm exec vitest run tests/perf/support` → FAIL.
- [ ] **Step 3: Cài đặt** đúng Interfaces. Mutation tự kiểm: đổi p99 thành p98, bỏ lấy trung vị (dùng trung bình), và để `renderMarkdown` bỏ cột p99 → mỗi cái phải làm ít nhất một test thất bại; báo cáo các đột biến đã chạy.
- [ ] **Step 4: Chạy** `corepack pnpm exec vitest run tests/perf/support`, `corepack pnpm test`, lint/typecheck/format:check → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/perf
git commit -m "feat(perf): histogram, stats, machine info and report writer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Vòng tải kín và lấy mẫu chờ khóa (kèm test canary)

**Files:**
- Create: `tests/perf/support/load-driver.ts`, `load-driver.test.ts` (thuần), `wait-stats.ts`, `wait-stats.test.ts` (thuần cho phần tính hiệu), `canary.perf.test.ts` (cần SQL Server)

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```ts
  // load-driver.ts
  export interface DriverOptions {
    concurrency: number
    durationMs: number                 // độ dài cửa sổ ĐO (không tính khởi động nóng)
    warmupMs: number
    task: (context: { worker: number; seq: number }) => Promise<void>   // ném lỗi = thao tác thất bại
    classify?: (error: unknown) => 'deadlock' | 'timeout' | 'other'     // mặc định: mã SQL 1205 → deadlock; thông báo/ mã timeout → timeout; còn lại other
    now?: () => number                 // tiêm được cho test
  }
  export interface DriverResult { ok: number; errors: { deadlock: number; timeout: number; other: number }; elapsedMs: number; throughputPerSec: number; latenciesMs: number[] }
  export function runClosedLoop(options: DriverOptions): Promise<DriverResult>
  // wait-stats.ts
  export interface WaitSnapshot { at: number; waits: Record<string, { waitMs: number; count: number }> }   // chỉ các wait_type LIKE 'LCK_M_%'
  export function snapshotWaits(admin: Kysely<unknown>): Promise<WaitSnapshot>
  export function diffWaits(before: WaitSnapshot, after: WaitSnapshot): Record<string, { waitMs: number; count: number }>   // chỉ giữ mục có delta > 0
  export class BlockedSampler {
    constructor(admin: Kysely<unknown>, options?: { intervalMs?: number; databaseName?: string })
    start(): void
    stop(): Promise<BlockedSummary[]>   // gom theo (waitType, câu lệnh chuẩn hóa: chữ thường, rút gọn khoảng trắng, tối đa 120 ký tự), sắp giảm dần theo count
  }
  ```
  Ngữ nghĩa `runClosedLoop`: N worker chạy vòng `task` liên tục; thao tác HOÀN TẤT trong `warmupMs` đầu không tính; cửa sổ đo dài `durationMs` kể từ hết khởi động nóng; thao tác đang bay khi hết cửa sổ vẫn được chờ xong nhưng chỉ tính nếu HOÀN TẤT trong cửa sổ; lỗi của `task` KHÔNG làm dừng worker (đếm theo `classify`) nhưng một lỗi nhiều lần liên tiếp ở mọi worker không được gây vòng lặp nóng vô hạn (mỗi worker có thể nhường event loop `setImmediate` giữa các vòng). `throughputPerSec = ok / (elapsedMs/1000)` với `elapsedMs` là độ dài cửa sổ đo thực tế.

- [ ] **Step 1: Viết test thất bại.** `load-driver.test.ts` (đồng hồ giả/tiêm `now` và tác vụ giả có độ trễ điều khiển được): số worker chạy đồng thời tối đa bằng `concurrency` (đo bằng bộ đếm đồng thời lớn nhất); thao tác hoàn tất trong khởi động nóng không tính; thao tác lỗi được phân loại đúng (tác vụ ném lỗi giả có `number: 1205` → deadlock, lỗi có message chứa 'timeout' → timeout, khác → other); `throughputPerSec` khớp `ok/elapsed` trên kịch bản biết trước; lỗi liên tục không gây vòng nóng (tác vụ ném ngay: số lần gọi bị chặn bởi nhường event loop — kiểm tra bằng đồng hồ giả hoặc giới hạn thời gian thực ngắn); `wait-stats.test.ts`: `diffWaits` chỉ giữ delta dương và tính đúng hiệu, bỏ qua loại chỉ có ở một phía. `canary.perf.test.ts` (SQL Server thật): tạo DB test, bảng nhỏ `hot(id int primary key, v int)` với 1 dòng; control: `runClosedLoop` 8 worker, mỗi thao tác `update hot set v = v + 1` (khoảng 3 s) → thông lượng control; hold: song song với lượt chạy thứ hai, một kết nối riêng mở transaction giữ khóa `update hot` trong ~1,5 s (rồi rollback) nằm giữa cửa sổ đo → khẳng định (a) thông lượng hold < 0,8 × control (b) `diffWaits` có tổng `LCK_M_*` waitMs tăng rõ rệt so với control (> 10× hoặc > 500 ms) (c) `BlockedSampler` thấy ít nhất một mẫu bị chặn có câu lệnh chứa `update hot`. Ngưỡng canary là so sánh TƯƠNG ĐỐI nội bộ trong cùng một lượt chạy, đủ rộng để không flaky; nêu rõ trong comment. Test chạy HAI lần liên tiếp để phát hiện chập chờn.
- [ ] **Step 2: Chạy** các test → FAIL.
- [ ] **Step 3: Cài đặt.** `snapshotWaits`: `select wait_type, wait_time_ms, waiting_tasks_count from sys.dm_os_wait_stats where wait_type like 'LCK_M_%'`. `BlockedSampler`: chu kỳ mặc định 100 ms: `select r.wait_type, r.wait_resource, t.text from sys.dm_exec_requests r cross apply sys.dm_exec_sql_text(r.sql_handle) t where r.blocking_session_id <> 0 and r.database_id = DB_ID(@db)`; lỗi truy vấn của sampler KHÔNG làm hỏng lượt đo (đếm và trả trong kết quả hoặc log), nhưng không được nuốt im lặng toàn bộ (ghi số lần lỗi). Mutation tự kiểm (báo cáo): bỏ khởi động nóng; để `diffWaits` trả cả delta âm; để canary giữ khóa 0 ms → canary phải thất bại.
- [ ] **Step 4: Chạy** `corepack pnpm exec vitest run tests/perf/support`, `corepack pnpm test:perf canary` hai lần, lint/typecheck/format:check, `corepack pnpm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/perf
git commit -m "feat(perf): closed-loop load driver, lock wait sampler and contention canary

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Môi trường đo mức use case, dựng dữ liệu và kiểm đúng đắn

**Files:**
- Create: `tests/perf/support/perf-env.ts`, `seed.ts`, `validity.ts`, `perf-env.perf.test.ts`

**Interfaces:**
- Consumes: use case của `services/wallet/src` (đọc code TRƯỚC: `application/{pay-order,apply-payment-result,reverse-transaction,adjust-wallet,create-wallet,request-topup,ops-recorder}.ts`, `infrastructure/system.ts` (SystemClock, RandomIdGenerator), `infrastructure/kysely/{unit-of-work,provisioning,schema}.ts`, `test-support.ts` (mẫu `createHarness`/`seedTopup` — chỉ để tham khảo; môi trường đo dùng đồng hồ và id THẬT), `domain/{tenant-id,customer-id}.ts`).
- Produces:
  ```ts
  export interface PerfEnv {
    tenants: TenantId[]; db: Kysely<WalletDatabase>; admin: Kysely<unknown>; databaseName: string
    uow: KyselyTenantUnitOfWork
    payOrder: PayOrder; applyPayment: ApplyPaymentResult; reverse: ReverseTransaction; adjust: AdjustWallet; createWallet: CreateWallet
    stop(): Promise<void>
  }
  export function createPerfEnv(options: { tenants: number }): Promise<PerfEnv>   // DB test riêng, provisionTenants, đồng hồ/ID thật, metrics noop, logger im lặng; stop() drop DB + đóng kết nối, idempotent, chạy cả khi dựng dở
  // seed.ts
  export interface SeededCustomer { tenant: TenantId; customerId: string }
  export function seedCustomers(env: PerfEnv, input: { count: number; balance: number; currency?: string; concurrency?: number }): Promise<SeededCustomer[]>   // tạo ví bằng CreateWallet rồi nạp bằng AdjustWallet CREDIT (đúng use case), có song song hóa; trải đều qua các tenant; số dư lớn để không cạn trong lượt đo
  export interface SeededTopup { tenant: TenantId; topupId: string; chargeId: string; amount: number }
  export function seedPendingTopups(env: PerfEnv, input: { count: number; customers: SeededCustomer[]; amount: number }): Promise<SeededTopup[]>   // tạo topup bằng RequestTopup rồi đưa sang PENDING có chargeId (xem seedTopup trong services/wallet/src/test-support.ts để biết cách làm đúng); mỗi topup dùng một lần trong kịch bản nạp tiền
  // validity.ts
  export interface LedgerCounts { orderPayments: number; orderPaymentTransactions: number; topupTransactions: number; reversalTransactions: number }
  export function readLedgerCounts(env: PerfEnv): Promise<LedgerCounts>   // cộng qua mọi tenant
  export function checkLedger(env: PerfEnv): Promise<string[]>   // trả danh sách vi phạm (rỗng = hợp lệ): tổng số dư mọi tài khoản của từng tenant = 0; mỗi số dư tài khoản = tổng dòng sổ cái của nó; mỗi giao dịch có tổng dòng = 0 (cùng ý với `expectLedgerInvariants` của wallet: sao chép SQL kèm chú thích nguồn); ném lỗi nếu truy vấn lỗi
  ```
  Quy ước kiểm đối chiếu (dùng ở Task 5): trước và sau lượt đo gọi `readLedgerCounts`; hiệu số phải bằng số thao tác thành công do driver báo cho từng loại (PAID → `orderPayments` và `orderPaymentTransactions` cùng tăng đúng bằng số `PAID`; áp nạp tiền `APPLIED` → `topupTransactions`; đảo thành công → `reversalTransactions`).

- [ ] **Step 1: Viết test thất bại** (`perf-env.perf.test.ts`, SQL Server thật): `createPerfEnv({tenants:2})` rồi `stop()` không để lại DB; `seedCustomers(count 50, balance 1_000_000)` → 50 ví có số dư đúng, trải đều 2 tenant (25/25 ± 1), `checkLedger` trả `[]`; `seedPendingTopups` → các topup ở trạng thái PENDING có `charge_id`; dùng `ApplyPaymentResult` thật cho một topup → `APPLIED`, `readLedgerCounts().topupTransactions` tăng 1; `payOrder.execute` thật cho một khách → `PAID`, counts tăng đúng; **test oracle của bộ đo**: làm hỏng trạng thái bằng admin (ví dụ `update accounts set balance = balance + 1` cho một ví) → `checkLedger` trả vi phạm nêu tài khoản; `stop()` idempotent và chạy cả khi `createPerfEnv` thất bại giữa chừng (mô phỏng bằng tên tenant không hợp lệ hoặc lỗi giả).
- [ ] **Step 2: Chạy** `corepack pnpm test:perf perf-env` → FAIL.
- [ ] **Step 3: Cài đặt.** Tham chiếu `tests/chaos/support/system-harness.ts` cho cách dựng cấu hình (không import harness chaos ở mức này); OpsActionRecorder cần `uow, clock, ids, log, metrics`. Mutation tự kiểm (báo cáo): để `checkLedger` bỏ qua kiểm tổng = 0; để `seedCustomers` không nạp tiền → test phải thất bại.
- [ ] **Step 4: Chạy** `corepack pnpm test:perf perf-env` HAI lần, lint/typecheck/format:check, `corepack pnpm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/perf
git commit -m "feat(perf): use-case level perf environment, seeding and ledger validity checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Các kịch bản đo (use case ×3 và đầu-cuối)

**Files:**
- Create: `tests/perf/support/runner.ts`, `tests/perf/scenarios/pay-order.perf.test.ts`, `topup-apply.perf.test.ts`, `mixed.perf.test.ts`, `e2e.perf.test.ts`, `tests/perf/scenarios/runner.perf.test.ts` (smoke 2 s)

**Interfaces:**
- Consumes: Task 1–4; harness chaos `tests/chaos/support/system-harness.ts` (`createSystem`, `assertSystemInvariants` từ `invariants.ts`) cho kịch bản đầu-cuối.
- Produces:
  ```ts
  // runner.ts — điều phối một kịch bản qua các mức đồng thời × số lần lặp
  export interface ScenarioDefinition {
    name: 'pay-order' | 'topup-apply' | 'mixed'
    description: string
    prepare(env: PerfEnv, config: PerfConfig, plan: { concurrency: number; repeat: number }): Promise<{
      task: DriverOptions['task']
      /** Sau lượt đo: đối chiếu số đếm sổ cái với kết quả driver; trả danh sách vi phạm (rỗng = hợp lệ). */
      verify(result: DriverResult, countsBefore: LedgerCounts, countsAfter: LedgerCounts): string[]
      cleanup?(): Promise<void>
    }>
  }
  export function runScenario(env: PerfEnv, config: PerfConfig, scenario: ScenarioDefinition, options?: { tag?: string }): Promise<ScenarioResult>   // với mỗi mức: lặp `repeats` lần: prepare → snapshotWaits + BlockedSampler.start → runClosedLoop → stop sampler + diffWaits → checkLedger (phải rỗng) + verify (phải rỗng) → RepeatResult; vi phạm → ném lỗi nêu kịch bản/mức/lần lặp (kết quả đo vô hiệu)
  ```
  Kịch bản: **pay-order:** mỗi thao tác chọn ngẫu nhiên một khách (từ tập đã seed với số dư lớn), gọi `PayOrder.execute` với `orderId` UUID mới, `eventId` UUID mới, số tiền nhỏ cố định (ví dụ 1 000 VND); chỉ kết quả `PAID` tính là thành công (REJECTED/khác tính là lỗi 'other'). **topup-apply:** mỗi thao tác lấy một topup PENDING chưa dùng (hàng đợi cấp phát đủ cho mọi thao tác dự kiến của lượt: ước lượng tối đa bằng `concurrency × durationSeconds × hệ số an toàn` và seed trước; hết thì dừng chạy bằng lỗi rõ ràng, không quay vòng) rồi gọi `ApplyPaymentResult.execute` (`charge.succeeded`, `APPLIED` mới tính là thành công). **mixed:** 70% trả order, 15% nạp tiền (cần hàng đợi topup), 10% điều chỉnh CREDIT ví ngẫu nhiên, 5% đảo giao dịch `ORDER_PAYMENT` đã tạo trong lượt (giữ danh sách giao dịch vừa trả; bỏ qua nếu chưa có); đối chiếu số đếm tương ứng. **Đầu-cuối** (`e2e.perf.test.ts`): `createSystem()` (chế độ trong tiến trình, không gây lỗi), seed ví và nạp tiền, rồi `PERF_E2E_ORDERS` đơn qua `system.sendOrder` với `PERF_E2E_CONCURRENCY` luồng; đo từ lúc gửi tới lúc `orders.received()` có `OrderPaidV1` của đơn đó (độ trễ từng đơn) và thông lượng toàn bộ; sau đó `system.heal()` và `assertSystemInvariants(system)`; `invariantsOk` vào báo cáo; vi phạm → ném lỗi. Mỗi tệp kịch bản ghi `PerfReport` một phần vào `PERF_OUT` (tên theo kịch bản và nhãn máy); Task 6 gộp.

- [ ] **Step 1: Viết test thất bại** `runner.perf.test.ts` (smoke thật, `PERF_DURATION_SECONDS=2`, `WARMUP=1`, `REPEATS=1`, mức 2 luồng, `PERF_CUSTOMERS=40`): chạy `pay-order` end-to-end: `ScenarioResult` có đúng 1 mức × 1 lần lặp, `ok > 0`, `errors` đều 0, thông lượng > 0, `waits` là object, báo cáo ghi được; một đột biến cố ý làm `verify` thất bại (ví dụ giả lập giảm số đếm sổ cái) → `runScenario` ném lỗi nêu kịch bản; lượt có `checkLedger` vi phạm (làm hỏng số dư giữa chừng bằng admin) → ném lỗi. Smoke cho `topup-apply` và `mixed` (cùng thông số rút gọn) và `e2e` (10 đơn, 4 luồng): đều hợp lệ, `invariantsOk === true`.
- [ ] **Step 2: Chạy** `corepack pnpm test:perf runner` → FAIL.
- [ ] **Step 3: Cài đặt** các kịch bản bám Interfaces; đọc code use case để dựng đầu vào đúng (ví dụ cách `PayOrder` yêu cầu `correlationId`, tenant, `customerId`). Mutation tự kiểm (báo cáo): để `verify` của pay-order luôn trả `[]` → test đột biến phải bắt; để driver không chờ thao tác đang bay → số đếm lệch.
- [ ] **Step 4: Chạy** `corepack pnpm test:perf runner` HAI lần; lint/typecheck/format:check; `corepack pnpm test` → PASS. Không chạy ma trận đầy đủ ở task này (để Task 6).
- [ ] **Step 5: Commit**

```bash
git add tests/perf
git commit -m "feat(perf): pay-order, topup-apply, mixed and end-to-end scenarios

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Chạy baseline, báo cáo phân tích và README

**Files:**
- Create: `docs/perf/merchant-hotspot.vi.md`, `docs/perf/baseline-<nhãn-máy>-2026-10-14.json` (+ `.md` sinh từ báo cáo), `tests/perf/scenarios/matrix.perf.test.ts` (gộp báo cáo)
- Modify: `README.md` (mục "Đo hiệu năng"), `docs/superpowers/specs/2026-10-14-merchant-hotspot-design.md` (trạng thái "Pha A đã triển khai"; ghi chú lệch so với thiết kế: kiểm đúng đắn mức use case dùng `validity.ts` thay vì `assertSystemInvariants`)

**Interfaces:**
- Produces: `matrix.perf.test.ts` chạy toàn bộ ma trận mặc định theo `PerfConfig` (ba kịch bản use case + đầu-cuối), gộp thành một `PerfReport` đầy đủ (`valid: true` chỉ khi mọi lượt hợp lệ), ghi `PERF_OUT/report-<nhãn>-<thời gian>.json/.md`. Script phụ (trong `package.json`, tùy chọn): không bắt buộc.

- [ ] **Step 1: Viết `matrix.perf.test.ts`** (không có ngưỡng thông lượng; chỉ khẳng định báo cáo đầy đủ: mỗi kịch bản × mỗi mức có `repeats.length === config.repeats`, `valid === true`).
- [ ] **Step 2: Chạy ma trận đầy đủ** với mặc định (`corepack pnpm test:perf matrix`; dự kiến 20–30 phút; máy phải rảnh: đóng ứng dụng nặng, dừng container khác nếu có — KHÔNG `down` stack billing-local; nếu đang chạy hãy báo trong báo cáo). Nếu máy nhiễu rõ rệt (độ phân tán min/max lớn hơn 25% trung vị ở nhiều mức) chạy lại một lần và ghi cả hai.
- [ ] **Step 3: Sao chép báo cáo JSON hợp lệ vào `docs/perf/baseline-<nhãn>-2026-10-14.json`** (và `.md`), KHÔNG chỉnh tay số liệu.
- [ ] **Step 4: Viết `docs/perf/merchant-hotspot.vi.md`** (tiếng Việt, giọng như `docs/ops/chaos-testing.vi.md`): mục đích và phạm vi Pha A; cách chạy (`test:perf`, biến PERF_*, thời lượng, yêu cầu Docker, máy rảnh); cách đọc báo cáo (thông lượng, p95/p99, lỗi/deadlock, bảng chờ khóa `LCK_M_*`, mẫu câu lệnh bị chặn); **bảng baseline** (thông lượng trung vị và p95/p99 theo mức đồng thời cho từng kịch bản, kèm min/max); **phân tích**: (1) đường cong thông lượng theo mức đồng thời — có bão hòa không, ở mức nào; (2) độ trễ đuôi; (3) chờ khóa nổi bật và câu lệnh bị chặn nhiều nhất; **nhận định H1–H3** của spec (đúng/sai/chưa kết luận) CHỈ dựa trên số đo, nêu rõ bằng chứng; so sánh trả order với nạp tiền (GATEWAY) và hỗn hợp; kết quả đầu-cuối so với mức use case; giới hạn (Windows + Docker Desktop, máy dev, vòng kín, không phải production); khuyến nghị ngưỡng để người dùng chốt (nêu các điểm gãy quan sát được, KHÔNG tự đặt ngưỡng thay người dùng). Kết thúc bằng mục "Điểm dừng — quyết định cho Pha B" liệt kê: số liệu then chốt, các hướng vá bậc 1 khả dĩ phù hợp với số đo, và câu hỏi cần người dùng trả lời.
- [ ] **Step 5: Cập nhật README và spec**; chạy `corepack pnpm exec prettier --write` chỉ trên tệp đã sửa, `corepack pnpm format:check`, `corepack pnpm exec vitest run tools/kibana/docs.test.ts`, `corepack pnpm test`, `corepack pnpm lint`.
- [ ] **Step 6: Commit** (có thể hai commit: tệp test ma trận; baseline + tài liệu)

```bash
git add tests/perf docs/perf docs/superpowers README.md
git commit -m "docs(perf): merchant hotspot baseline and analysis (phase A)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Cổng cuối của Pha A

- [ ] **Step 1: Chạy TUẦN TỰ (không chạy hai lượt nặng song song):**

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm format:check
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:contract
corepack pnpm test:perf smoke canary perf-env runner
docker compose -f deploy/compose.local.yml --env-file deploy/.env config -q
corepack pnpm kibana:build -- --defaults-only && git diff --stat -- deploy/kibana
```

Kỳ vọng: tất cả xanh; `test:integration` không đổi (609); `test:chaos` KHÔNG cần chạy lại (không đổi code production/harness; chỉ ghi nhận nếu bạn chạm tới `tests/chaos`). Nếu tệp lỗi `beforeAll` do SQL Server khởi động thì chạy riêng tệp đó và báo cả hai kết quả.
- [ ] **Step 2: Dọn dẹp** — `git status --short` sạch (không có `tests/perf/.out/` trong commit); `git diff main..HEAD -- . ':!docs' | Select-String '^\+.*(console\.log|\.only\(|TODO|FIXME|debugger)'` chỉ cho phép dòng in kết quả có chủ đích trong `tests/perf`; `git diff main..HEAD -- services packages db` PHẢI rỗng (Pha A không đổi code production).
- [ ] **Step 3: Báo cáo** — danh sách commit, kết quả từng lệnh, tóm tắt số liệu baseline, và lời nhắc: DỪNG tại đây cho quyết định Pha B. KHÔNG push hay merge.

---

## Self-Review (đã thực hiện)

- **Phủ spec:** quyết định 1 (đo trước, người dùng chốt ngưỡng) → Task 6 (điểm dừng); 2 (mức vá) thuộc Pha B, chỉ nêu hướng ở Task 6; 3 (use case + đầu-cuối) → Task 4–5; 4 (lệnh riêng, baseline commit, không CI) → Task 1, 6; 5 (kiểm đúng đắn) → Task 4–5 (mức use case dùng `validity.ts`, đầu-cuối dùng oracle chaos; lệch spec được ghi ở Task 6); 6 (không đổi code production) → Global Constraints và Task 7 Step 2. Bộ đo spec §3 → Task 2–5; nhiễu §4 → Task 2, 5, 6; tự kiểm §5 → Task 2–5 (canary ở Task 3); bàn giao §6 → Task 6; ngoài phạm vi §7 → Global Constraints; rủi ro §8 → Task 3 (sampler), Task 6 (máy rảnh).
- **Chữ ký nhất quán:** `PerfConfig`, `LatencySummary`, `RepeatResult`, `LevelResult`, `ScenarioResult`, `PerfReport`, `DriverOptions/DriverResult`, `WaitSnapshot`, `BlockedSampler`, `PerfEnv`, `LedgerCounts`, `ScenarioDefinition` được định nghĩa một lần (Task 1–5) và dùng đúng tên ở task sau.
- **Điểm implementer phải tự xác minh bằng đọc code:** đầu vào chính xác của `PayOrder`/`ApplyPaymentResult`/`ReverseTransaction`/`AdjustWallet` và cách đưa topup sang PENDING (Task 4–5); cách `createSystem`/`sendOrder`/`orders.received()` hoạt động cho đo độ trễ đầu-cuối (Task 5); tên cột/DMV SQL Server cho lấy mẫu chờ khóa chạy được trên phiên bản container (Task 3); số lượng topup cần seed trước cho lượt nạp tiền (Task 5).
