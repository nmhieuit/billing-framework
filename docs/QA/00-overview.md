# QA tổng quan: hiện trạng test và đề xuất strategy

> **Giai đoạn 1.** Tài liệu này chỉ dựa trên repo `billing-framework` (commit `5f85815`), ngày lập 2026-10-13.
> **Không có lệnh nào được chạy** (không `pnpm install`, không chạy test, không đo coverage): mọi số liệu là **đếm tĩnh** từ mã nguồn.
> Mục nào không kiểm chứng được ghi **"Chưa xác minh"** và nằm trong [mục 7](#7-câu-hỏi-còn-mở).
> Tài liệu này không dùng skill `engineering:testing-strategy` vì skill không nạp được trong phiên làm việc (theo xác nhận của người yêu cầu).

## 1. Dự án là gì (đủ để đọc phần sau)

- Monorepo TypeScript, pnpm workspace, Node >= 22 (`package.json`, `.nvmrc`).
- Hai service độc lập: **payment** (Fastify, cổng thanh toán giả lập, `:3002`) và **wallet** (NestJS, ví nạp trước + ledger ghi sổ kép, `:3001`) (`README.md:3-4`, `README.md:17-18`).
- Thư viện dùng chung ở `packages/*`: `contracts`, `database`, `messaging`, `money`, `observability`, `runtime`, `testing`.
- Hạ tầng: SQL Server, RabbitMQ; quan sát bằng OTel + Elasticsearch/Kibana (`deploy/compose.local.yml`, `README.md` mục "Chạy local một lệnh").
- Ecommerce là hệ thống ngoài repo, giao tiếp bằng event qua RabbitMQ và hợp đồng JSON Schema (`README.md` mục "Hợp đồng với ecommerce").

## 2. Hiện trạng test

### 2.1 Framework, cấu trúc, cách chạy

| Hạng mục | Hiện trạng | Dẫn chứng |
| --- | --- | --- |
| Framework | Vitest 5 + `@vitest/coverage-v8` | `package.json` (devDependencies) |
| Test unit | Mọi `*.test.ts` **trừ** `*.integration.test.ts`; lệnh `pnpm test` | `vitest.config.ts:5-6`, `package.json` script `test` |
| Test integration | `*.integration.test.ts`, cần **Docker** (SQL Server qua testcontainers, một container dùng chung); chạy tuần tự (`fileParallelism: false`); timeout 60 s/test, 180 s/hook | `vitest.integration.config.ts:6-11` |
| Contract (Pact) | Consumer pact ở bộ unit, provider verify ở bộ integration; lệnh `pnpm test:contract` | `services/wallet/src/contract/wallet-consumer.pact.test.ts`, `wallet-provider.pact.integration.test.ts`, `package.json` script `test:contract` |
| Test hạ tầng dùng chung | Package `@billing/testing`: container SQL Server/RabbitMQ, fake clock, fake payment server, webhook receiver, free port, wait-for | `packages/testing/src/*` |
| Kiểm tra kiến trúc | Test ranh giới `domain`/`application` bằng ESLint | `tools/boundaries.test.ts:1-50` |
| Vị trí test | Đặt cạnh code (`*.test.ts` cùng thư mục `src`), riêng E2E ở `tests/e2e/` | `git ls-files` |
| Static checks | `lint`, `typecheck`, `format:check` | `package.json` scripts, `Jenkinsfile:38-43` |

### 2.2 CI/CD có chạy test không

Có. CI là **Jenkins** (`Jenkinsfile`); không có thư mục `.github/` nên **không có GitHub Actions** (kiểm tra bằng `ls .github`: không tồn tại).

| Stage | Lệnh | Dòng |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | `Jenkinsfile:31-35` |
| Static checks | `lint`, `typecheck`, `format:check` | `Jenkinsfile:38-43` |
| Test | `pnpm test:coverage` (unit + coverage) | `Jenkinsfile:46-49` |
| Integration tests | `pnpm test:integration` (cần Docker daemon) | `Jenkinsfile:52-56` |
| Contract tests (Pact) | **Chỉ chạy khi** biến `PACT_BROKER_BASE_URL` được định nghĩa; `can-i-deploy` mặc định chỉ cảnh báo (`PACT_ENFORCE_CAN_I_DEPLOY=false`) | `Jenkinsfile:14`, `59-95` |
| SonarQube + Quality Gate | `sonar-scanner`, `waitForQualityGate abortPipeline: true` | `Jenkinsfile:97-112` |

- Timeout pipeline 30 phút (`Jenkinsfile`, `options`).
- **Chưa xác minh:** `PACT_BROKER_BASE_URL` có được định nghĩa ở job thật không (nằm ngoài repo) nên chưa biết stage Pact có chạy thực tế không; ngưỡng Quality Gate cấu hình ở server SonarQube nên chưa biết.
- Pact chỉ có phía wallet (consumer của orders, provider của sự kiện); phía ecommerce chưa verify (`Jenkinsfile:88` ghi "cho đến khi ecommerce verify pact").

### 2.3 Độ phủ (coverage)

**Chưa đo được.** Lý do: chưa được phép `pnpm install` và chạy `pnpm test:coverage`, và test integration cần Docker (chưa biết môi trường này có Docker không).

Cấu hình đo sẵn có:
- Provider `v8`, report `text` + `lcov`, phạm vi `packages/*/src/**` và `services/*/src/**`, loại `*.test.ts` và `main.ts` (`vitest.config.ts:7-12`).
- Lưu ý: `pnpm test:coverage` chỉ đo **bộ unit** (config loại `*.integration.test.ts` ở `vitest.config.ts:6`). Số coverage này sẽ **thấp hơn thực tế** vì phần lớn test (bộ integration) không được tính. `sonar.javascript.lcov.reportPaths=coverage/lcov.info` cũng chỉ nhận lcov từ lệnh đó (`sonar-project.properties`).
- **Không có ngưỡng coverage** trong `vitest.config.ts` (không có `thresholds`). Chưa xác minh ngưỡng ở SonarQube server.

### 2.4 Các test layer đang có

Số liệu: đếm các dòng bắt đầu bằng `it(` hoặc `test(` trong `**/*.test.ts` (`git ls-files`). Đây là **ước lượng tĩnh**: `it.each` không được bung ra, cú pháp lạ có thể bị sót, và không phản ánh test đang skip (grep `it.skip|describe.skip|.only|.todo` không thấy kết quả nào).

| Layer | Có? | Bằng chứng | File | Case |
| --- | --- | --- | --- | --- |
| Unit (domain, application, route với fake, adapter) | Có | `*.test.ts` không có hậu tố `integration` | 78 (gồm tools) | 485 (gồm 142 của `tools/`) |
| Integration (DB/MQ thật qua container, gồm HTTP API wallet) | Có | `*.integration.test.ts` | 64 | 517 (gồm 5 case E2E) |
| Contract (Pact, message) | Có, phạm vi hẹp | 2 file ở `services/wallet/src/contract/`; fixtures `services/wallet/pact-fixtures/` | 2 (đã nằm trong các số trên) | 4 |
| E2E wallet + payment | Có, rất mỏng | `tests/e2e/billing.integration.test.ts:164-` (5 `it`) | 1 | 5 |
| Migration test | Có | `db/payment/migrations.integration.test.ts`; `services/wallet/src/infrastructure/kysely/*-migration.integration.test.ts` | 5 | n/a |
| Test kiến trúc | Có | `tools/boundaries.test.ts` | 1 | n/a |
| UI / browser E2E | **Không có** | Không có dự án UI; grep `playwright|cypress|selenium` không thấy | 0 | 0 |
| Performance / load | **Không có** | grep `k6|artillery|autocannon|jmeter|gatling` ngoài `pnpm-lock.yaml`: không thấy | 0 | 0 |
| Security test tự động | **Không có** | grep `owasp|zap`: không thấy (Sonar quét tĩnh có trong CI nhưng ngưỡng chưa xác minh) | 0 | 0 |
| API test độc lập (Postman/Newman) | **Không có** | Không có file `*.postman_collection.json`; không có OpenAPI/Swagger trong repo | 0 | 0 |
| Manual test case/plan | **Không có** | Không có tài liệu QA trước tài liệu này | 0 | 0 |

Test E2E hiện có (`tests/e2e/billing.integration.test.ts`): nạp tiền từ yêu cầu đến số dư (`:165`); cùng `Idempotency-Key` gửi 5 lần đồng thời (`:195`); cô lập tenant (`:228`); ví bị freeze từ chối order (`:270`); sổ cái cân và khớp với payment (`:303`).

### 2.5 Test Pyramid thực tế

Tách `tools/` (kiểm thử script vận hành Kibana/seed, không phải logic nghiệp vụ) để pyramid phản ánh sản phẩm:

| Layer (nghiệp vụ: `services/`, `packages/`, `db/`, `tests/`) | Case | Tỷ lệ |
| --- | --- | --- |
| Unit (không cần container) | 343 | 39,9 % |
| Integration (container thật, gồm API wallet/payment) | 512 | 59,5 % |
| E2E liên service | 5 | 0,6 % |
| UI / Performance / Security tự động | 0 | 0 % |
| **Tổng** | **860** | 100 % |

Chi tiết theo module (case unit / integration, ước lượng tĩnh):

| Module | Unit | Integration |
| --- | --- | --- |
| `services/wallet` | 145 | 376 |
| `services/payment` | 82 | 89 |
| `packages/*` | 116 | 42 |
| `db/` | 0 | 5 |
| `tests/e2e` | 0 | 5 (E2E) |
| `tools/` (không tính ở bảng trên) | 142 | 0 |

**Lệch pha so với pyramid lý tưởng (nhiều unit, ít integration, rất ít E2E):**
- Phần integration (59,5 %) **lớn hơn** unit (39,9 %): hình dạng gần "ice-cream cone ở giữa / diamond", không phải pyramid. Riêng `services/wallet`: 376 integration so với 145 unit (khoảng 72 % integration).
- Điều này **không hẳn xấu** với hệ thống tiền bạc có nhiều ràng buộc ở DB (lock, unique, transaction). Nhưng nó có nghĩa là test chậm, bắt buộc có Docker và chạy tuần tự (`fileParallelism: false`, `vitest.integration.config.ts:11`).
- Tầng E2E chỉ có 5 case; **chưa xác minh** các hành trình E2E còn thiếu có cần thiết không.
- Không có test nào ở tầng "chạy trên môi trường đã deploy" (smoke/regression qua HTTP vào stack đang chạy): đây là chỗ manual test và Postman sẽ lấp.
- Nhận định này dựa trên số đếm tĩnh; coverage thật chưa đo nên chưa biết "nhiều test" có nghĩa là "phủ tốt".

## 3. Bề mặt API xác minh được từ code (cho manual test và Postman)

Repo **không có** file OpenAPI/spec; danh sách dưới đây rút từ controller/route. Chi tiết body/response **chưa được đọc đầy đủ**, sẽ đọc kỹ ở Giai đoạn 2.

**Wallet** (NestJS, `:3001`; danh tính qua header do gateway đặt: `x-tenant-id`, `x-customer-id`; ops thêm `x-actor-id`, `x-actor-role: OPS`; `README.md` mục Wallet và "Công cụ vận hành"; **không có cơ chế token/Authorization trong code**: grep `authorization|x-api-key` ở `services/*/src` (không tính test) không thấy):

| Endpoint | Nguồn |
| --- | --- |
| `GET /health` | `services/wallet/src/interface/http/health.controller.ts:3-5` |
| `POST /wallets`, `GET /wallet`, `GET /wallet/entries` | `wallets.controller.ts:20,42,47` |
| `POST /topups`, `GET /topups/:id` | `topups.controller.ts:42,66` |
| `POST /webhooks/payment` | `webhooks.controller.ts:32` |
| `POST /reconciliations`, `GET /reconciliations/:runId`, `GET /reconciliations/:runId/items`, `POST /reconciliation-items/:id/resolve` | `reconciliations.controller.ts:40,46,51,71` (có `TenantGuard`, `:28`) |
| Ops: `POST /ops/wallets/:customerId/freeze`, `.../unfreeze`, `.../adjustments`; `POST /ops/transactions/:id/reversals`; `POST /ops/orders/:orderId/replay-paid`; `GET /ops/actions` | `ops.controller.ts:39,51,65,79,97,106,112`; mô tả `docs/ops/ops-tools.vi.md` |

**Payment** (Fastify, `:3002`): `GET /health` (`health.route.ts:4`), `POST /charges` (`charges.route.ts:19`, header `idempotency-key`, `x-simulate`), `GET /settlements` (`settlements.route.ts:12`). `GET /charges/{id}` được README nhắc (`README.md`, mục Payment simulator) nhưng **chưa xác minh** vị trí trong code.

**Bất đồng bộ (không gọi bằng HTTP):** wallet nhận `order-ready` và trả `OrderPaidV1`/`OrderPaymentFailedV1` qua RabbitMQ (`services/wallet/src/interface/messaging/`, `docs/integration/orders-handoff.vi.md`): manual test cần RabbitMQ management hoặc công cụ khác. **Chưa xác minh** quy trình publish tay trong môi trường thật.

## 4. Khoảng trống và rủi ro chính

Mỗi mục có mức **tin cậy** để phân biệt cái đã thấy với cái suy từ cấu trúc. Khi có coverage thật, mục 4.2 sẽ được thay bằng số liệu.

### 4.1 Khoảng trống đã xác minh (bằng việc thiếu file/loại test)

1. **Không có test cho UI, performance, security tự động, API độc lập, manual** (bảng 2.4).
2. **Contract chỉ một chiều:** ecommerce chưa verify pact (`Jenkinsfile:88`); stage Pact chỉ chạy khi có biến môi trường ngoài repo (`Jenkinsfile:60`).
3. **Coverage CI chỉ đo bộ unit** (`vitest.config.ts:6`), nên chỉ số Sonar có thể không phản ánh đúng.
4. **Không có ngưỡng coverage trong repo** (`vitest.config.ts:7-12`).
5. **Hành vi hệ thống đã deploy** (cấu hình, mạng, cổng, biến môi trường, gateway) không được test tự động: E2E dựng service in-process (`tests/e2e/billing.integration.test.ts:12-23`).

### 4.2 Khoảng trống chưa xác minh (cần coverage hoặc đọc sâu)

- Chưa biết file/branch nào thật sự không được chạy qua test. (Đã thử so tên file nguồn với test: kết quả không đáng tin vì controller/repository được test gián tiếp qua test API/integration, nên **không** dùng làm bằng chứng.)
- Chưa biết các nhánh lỗi của từng endpoint (4xx/5xx) phủ đến đâu. Đã thấy mỗi endpoint wallet/payment xuất hiện trong ít nhất 2 file test (đếm chuỗi route trong `*.test.ts`), nhưng "có xuất hiện" khác với "đủ negative/edge case".
- Rủi ro nghiệp vụ cao theo bản chất hệ thống (nên ưu tiên khi manual test, **cần bạn xác nhận**): nạp tiền và webhook trùng/mất, idempotency và đồng thời, ledger cân và số dư khớp, cô lập tenant, freeze/adjust/reverse bởi ops, thanh toán order bất đồng bộ qua RabbitMQ và DLQ, đối soát, retention xóa thật (`RETENTION_DRY_RUN=false`, `README.md` mục Dọn dữ liệu: không hoàn tác).

## 5. Đề xuất Test Strategy (mức tổng quan, chờ bạn xác nhận giả định)

Dựa đúng vào cấu trúc hiện có; không thêm công cụ mới nếu chưa cần.

| Chủ đề | Đề xuất | Giả định cần xác nhận |
| --- | --- | --- |
| Phạm vi | Wallet, payment, hợp đồng event với ecommerce; ngoài phạm vi: bản thân ecommerce | Ecommerce ngoài phạm vi QA này |
| Test layer | Giữ unit + integration + contract + E2E hiện có; **bổ sung** manual smoke/regression trên stack local và Postman (smoke + regression) trên stack đang chạy | Có môi trường chạy được (local stack hay staging?) |
| Pyramid mục tiêu | Không ép về pyramid cổ điển. Đề xuất: giữ integration làm tầng chính cho logic có DB, **tăng unit** cho logic thuần (domain), **tăng E2E/smoke** từ 5 lên các hành trình nghiệp vụ chính. Tỷ lệ cụ thể **không đặt** khi chưa có coverage và chưa biết kỳ vọng của bạn | Tỷ lệ mục tiêu: bạn quyết |
| Tiêu chí vào | Build xanh ở CI (lint, typecheck, unit, integration); stack local lên được (`docker compose`); `local:seed` chạy được | Có dùng seed để tạo dữ liệu mẫu không |
| Tiêu chí ra | 100 % test case Smoke pass; không còn defect mức Critical/High mở; Regression pass theo ngưỡng bạn đặt | Ngưỡng pass: bạn quyết |
| Test data | Dùng `pnpm local:seed` (`tools/local/seed.ts`) và tenant `acme`/`beta` như ví dụ trong test/README; mỗi lần chạy dùng `idempotency-key` mới để tránh va chạm | Tenant nào dùng cho QA: bạn quyết |
| Môi trường | Local stack `deploy/compose.local.yml` là môi trường duy nhất xác minh được từ repo; staging/prod **chưa xác minh** | Môi trường test chính thức: bạn quyết |
| CI gate | Đã có: lint, typecheck, format, unit + coverage, integration, Sonar gate. Đề xuất cân nhắc: đo coverage cả bộ integration, đặt ngưỡng, bật `PACT_ENFORCE_CAN_I_DEPLOY` khi ecommerce verify | Ngưỡng và có đổi CI hay không: bạn quyết |
| Ưu tiên theo rủi ro | Tiền (ledger, nạp, ops adjust/reverse) > idempotency/đồng thời > tenant isolation > bất đồng bộ order > đối soát > retention > quan sát | Thứ tự ưu tiên: bạn xác nhận |
| Manual vs tự động hóa | **Manual trước:** hành trình qua UI/ops thật, kịch bản `X-Simulate` (lỗi, trễ, webhook rơi/trùng), kiểm tra dashboard/alert Kibana, quy trình retention dry-run sang xóa thật, DLQ. **Tự động hóa sau:** smoke Postman/Newman trong CI, kiểm tra schema/contract, các kịch bản idempotency lặp lại | Mức độ đầu tư tự động hóa: bạn quyết |

## 6. Mục lục các nhóm có thể đào sâu (Giai đoạn 2, chỉ làm khi bạn chọn)

Mỗi nhóm sẽ là một tài liệu riêng trong `docs/QA/`.

| # | Nhóm | Mô tả ngắn | File dự kiến |
| --- | --- | --- | --- |
| A | Manual test plan: Wallet core | Tạo ví, nạp tiền (`/topups`), webhook từ payment, sổ cái và danh sách entries; test case có ID, tiền điều kiện, bước, kết quả mong đợi, ưu tiên, Smoke/Regression | `01-manual-wallet-core.md` |
| B | Manual test plan: Payment simulator | `POST /charges`, `GET /settlements`, các kịch bản `X-Simulate` (fail, delay, webhook drop/duplicate, timeout), idempotency | `02-manual-payment-simulator.md` |
| C | Manual test plan: Thanh toán order và RabbitMQ | `order-ready` sang `OrderPaidV1`/`OrderPaymentFailedV1`, ví bị freeze, DLQ | `03-manual-order-payment.md` |
| D | Manual test plan: Ops tools | freeze/unfreeze, adjustments, reversals, replay-paid, nhật ký `ops_actions`, header `x-actor-*`, mã lỗi | `04-manual-ops-tools.md` |
| E | Manual test plan: Đối soát | `POST /reconciliations`, items, resolve, dữ liệu lệch | `05-manual-reconciliation.md` |
| F | Manual test plan: Retention và quan sát | dry-run sang xóa thật, dashboard/rule Kibana, metric | `06-manual-retention-observability.md` |
| G | Postman Smoke | Luồng E2E happy case, biến môi trường (`{{base_url}}`...), `pm.test`, chaining; kèm environment file | `postman/` + `07-postman-smoke.md` |
| H | Postman Regression | Negative và edge case (validation, idempotency conflict, header thiếu/sai, tenant lạ) | `postman/` + `08-postman-regression.md` |
| I | Kế hoạch tự động hóa và đo coverage | Chạy đo coverage thật (sau khi bạn cho phép), đề xuất ngưỡng và lộ trình tự động hóa | `09-automation-and-coverage.md` |

Postman chỉ chứa request cho endpoint ở mục 3. Endpoint nào chưa chắc sẽ hỏi bạn.

## 7. Câu hỏi đã trả lời và còn mở

### 7.1 Đã được xác nhận (bởi người yêu cầu)

| # | Nội dung | Quyết định | Tác động |
| --- | --- | --- | --- |
| 1 | Đo coverage thật | **Không cần.** Coverage giữ trạng thái "Chưa đo" | Mục 2.3 giữ nguyên; nhóm I (mục 6) chỉ còn lộ trình tự động hóa, không đo |
| 2 | Môi trường manual test | **Local stack** (`deploy/compose.local.yml`) | Test case và Postman nhắm vào local stack; staging/prod ngoài phạm vi |
| 4 | Ngưỡng coverage và kỳ vọng | **Không cần** | Không đặt ngưỡng ở mục 5 |
| 5 | `/ops` và `/reconciliations` | **Có gồm.** Tách theo folder | Postman và test plan chia folder riêng cho ops và reconciliations |
| 6 | Pact Broker và Sonar | **Ngoài phạm vi** | Các mục "Chưa xác minh" về Pact/Sonar ở mục 2.2 được giữ nguyên, không theo đuổi thêm |
| 7 | Vị trí tài liệu | Dưới `docs/QA/` | Đã áp dụng |

### 7.2 Đã xác nhận ở lượt sau

| # | Nội dung | Quyết định |
| --- | --- | --- |
| 3 | Thứ tự ưu tiên | tiền, idempotency/đồng thời, tenant, order bất đồng bộ, đối soát, retention; làm nhóm theo thứ tự này |
| 2 | Cách xác thực | QA **tự đặt** header `x-tenant-id`/`x-customer-id`/`x-actor-*` |
| 3 | Quyền ghi dữ liệu trên local stack | **Được phép** |
| 5 | Cấu trúc folder | Ổn (`docs/QA/postman/{wallet,payment,ops,reconciliations}/`) |

### 7.3 Còn mở

1. Cổng thực tế khi chạy `compose.local.yml` đã có trong `docs/ops/local-stack.vi.md` (wallet 3001, payment 3002, đổi được bằng biến); chưa chạy kiểm chứng.
2. Ecommerce: ai xác nhận contract `order-ready`/`OrderPaidV1` và cách publish tay vào RabbitMQ (cho nhóm C).
3. Retention: đã được phép xóa thật (`RETENTION_DRY_RUN=false`, không hoàn tác) trên local stack; áp dụng khi viết nhóm F.

## 8. Tiến độ Giai đoạn 2

| Nhóm | Trạng thái | File |
| --- | --- | --- |
| A. Wallet core (tiền, idempotency nạp, tenant) | Đã viết, chưa chạy thật | [`01-manual-wallet-core.md`](01-manual-wallet-core.md) |
| B. Payment simulator | Đã viết, chưa chạy thật | [`02-manual-payment-simulator.md`](02-manual-payment-simulator.md) |
| C. Thanh toán order và RabbitMQ | Đã viết, chưa chạy thật | [`03-manual-order-payment.md`](03-manual-order-payment.md) |
| D. Ops tools | Đã viết, chưa chạy thật | [`04-manual-ops-tools.md`](04-manual-ops-tools.md) |
| E. Đối soát | Đã viết, chưa chạy thật | [`05-manual-reconciliation.md`](05-manual-reconciliation.md) |
| F. Retention và quan sát | Đã viết, chưa chạy thật | [`06-manual-retention-observability.md`](06-manual-retention-observability.md) |
| G. Postman Smoke | Đã viết, chưa chạy thật | [`07-postman-smoke.md`](07-postman-smoke.md); `postman/*/*.postman_collection.json`, `postman/billing-local.postman_environment.json` |
| H. Postman Regression | Đã viết, chưa chạy thật | [`08-postman-regression.md`](08-postman-regression.md) |
| J. Postman EndPoints (liệt kê endpoint + enum) | Đã viết, chưa chạy thật | [`09-postman-endpoints.md`](09-postman-endpoints.md); folder `EndPoints` trong 4 collection và `postman/*/endpoints.folder.postman_collection.json` |
| K. Chaos: rà soát code + test thủ công | Đã viết, chưa chạy thật (`pnpm test:chaos` chưa chạy: không có Docker; test công cụ chaos không cần Docker: 11 file/92 test xanh) | [`10-manual-chaos.md`](10-manual-chaos.md) |
| L. Postman Chaos (tải nền + oracle) | Đã viết, chỉ chạy trên mock | [`11-postman-chaos.md`](11-postman-chaos.md); `postman/chaos/chaos.postman_collection.json` |
| I. Tự động hóa và đo coverage | **Không làm** (theo yêu cầu) | |

### 7.4 Xác nhận bổ sung (lượt sau)

| Nội dung | Quyết định |
| --- | --- |
| Retention: cách lấy dữ liệu đủ cũ | **Cách A**: đặt `RETENTION_OUTBOX_SENT_DAYS=1` và `RETENTION_WEBHOOK_DAYS=1`, tạo dữ liệu, chờ ≥ 1 ngày; chỉ phủ `outbox_sent` và `webhook_*`. Các case "cần B" (SQL) bị chặn |
| Đối soát: tạo lại container wallet với `RECONCILE_AUTOFIX=false` | Được phép (REC-034) |
| Đối soát: case chờ nhiều giờ (REC-052, REC-053) | Giữ lại |
| Rủi ro "hết cửa sổ idempotency tạo topup thứ hai" | Không cần ghi nhận riêng |
| Postman | Chỉ làm G và H; không làm I |
