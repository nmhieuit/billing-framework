# Các loại test đang có trong source

Tài liệu này cho biết repo có những loại test nào, nằm ở đâu, chạy thế nào, kiểm được gì và không kiểm được gì. Phạm vi: toàn bộ repo, gồm `services/wallet`, `services/payment`, `packages/*`, `db/`, `tools/`, `tests/`. Test của `db/` (migration) và `tools/` (công cụ Kibana, dữ liệu mẫu, khởi tạo RabbitMQ, kiểm kiến trúc), cùng test của chính công cụ chaos/perf, được **tính trong số liệu** và liệt kê thành nhóm riêng ở mục 2.8 để không lẫn với test sản phẩm.

**Nhãn bằng chứng:** **đếm tĩnh** là đếm trong source, không chạy; **chạy thật** là kết quả lệnh đã chạy ngày 2026-10-15; **cấu hình** là đọc từ file cấu hình hoặc `Jenkinsfile`.

## 1. Bảng tổng hợp

Repo phân loại test bằng **đuôi tên file**, và mỗi đuôi dùng một cấu hình Vitest riêng.

| # | Loại | Nhận diện | Lệnh | Cần Docker | Chạy trong CI (`Jenkinsfile`) | Số file (đếm tĩnh) | Số test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Unit | `*.test.ts` | `pnpm test` | Không | Có (stage Test, kèm coverage) | 99 (gồm 33 file test công cụ, xem 2.8) | **1034** (chạy thật) |
| 2 | Integration | `*.integration.test.ts` | `pnpm test:integration` | Có | Có (stage Integration tests) | 64 | **609** (chạy thật) |
| 3 | Contract (Pact) | `*.pact.test.ts` (consumer, nằm trong unit) và `*.pact.integration.test.ts` (provider, nằm trong integration) | `pnpm test:contract` (provider) | Provider: có | Chỉ khi job định nghĩa `PACT_BROKER_BASE_URL` | 2 (đã nằm trong số trên) | 4 (đếm tĩnh; đã nằm trong số trên) |
| 4 | E2E trong process | `tests/e2e/billing.integration.test.ts` | `pnpm test:integration` | Có | Có (cùng bộ integration) | 1 (đã nằm trong integration) | 5 (chạy thật; đã nằm trong số trên) |
| 5 | Chaos | `*.chaos.test.ts` | `pnpm test:chaos` | Có | **Không thấy** | 10 | 130 (đếm tĩnh; chưa chạy) |
| 6 | Soak | `*.soak.test.ts` | `pnpm test:chaos:soak` | Có | **Không thấy** | 1 | 1 (đếm tĩnh; chưa chạy) |
| 7 | Perf | `*.perf.test.ts` | `pnpm test:perf` | Có | **Không thấy** | 10 | 27 (đếm tĩnh; chưa chạy) |

Các loại không phải test nhưng nằm trong quy trình kiểm tra: `lint`, `typecheck`, `format:check` (đều chạy trong CI) và SonarQube. Ngoài ra bộ **Postman** của QA nằm trong `docs/QA/postman/` (mục 2.9).

## 2. Chi tiết từng loại

### 2.1 Unit

- **Là gì:** kiểm một đơn vị code nhỏ (domain, hàm, route với use case giả, adapter) nhanh, không cần DB hay broker thật.
- **Nhận diện / lệnh / CI:** như bảng 1; cấu hình `vitest.config.ts` (loại trừ các đuôi `integration`, `chaos`, `soak`, `perf`).
- **Số lượng:** 99 file, 1034 test (chạy thật). Đếm tĩnh các khối `it(`/`test(` chỉ ra 663; thấp hơn vì các `it.each` được bung ra khi chạy. Chia theo khu vực (chạy thật):

| Khu vực | File | Test |
| --- | --- | --- |
| `services/wallet` | 26 | 283 |
| `services/payment` | 15 | 160 |
| `packages/*` | 24 | 220 |
| Consumer Pact của wallet | 1 | 2 |
| Công cụ (xem 2.8) | 33 | 369 |

- **Kiểm được:** logic thuần (ví dụ trạng thái topup, đối soát, phân loại charge), validate cấu hình, mapping lỗi, route HTTP của payment với use case giả, metric.
- **Không kiểm được:** tương tác với DB và broker thật (khóa, giao dịch, ràng buộc), luồng nhiều service, môi trường đã deploy.

### 2.2 Integration

- **Là gì:** kiểm với SQL Server (và RabbitMQ khi cần) thật chạy trong container do test dựng, một container dùng chung cho cả lượt chạy; chạy tuần tự (`fileParallelism: false`).
- **Nhận diện / lệnh / CI:** như bảng 1; cấu hình `vitest.integration.config.ts`.
- **Số lượng:** 64 file, 609 test (chạy thật, tất cả pass, khoảng 10 phút). Đếm tĩnh 529; chênh do `it.each`. Chia nhóm (chạy thật):

| Nhóm | File | Test | Kiểm gì |
| --- | --- | --- | --- |
| Use case với DB thật (`application/*.integration`) | 29 | 293 | Nghiệp vụ từ đầu đến cuối ở tầng ứng dụng: tạo ví, nạp tiền, trả order, ops, đối soát, retention |
| Repository (`infrastructure/kysely/*`) | 11 | 103 | Câu lệnh SQL, ràng buộc, khóa, truy vấn |
| API HTTP trong process (`interface/http/*.integration`) | 3 | 87 | Endpoint wallet qua HTTP in-process và DB thật: mã lỗi, header, idempotency, chữ ký webhook |
| Service nguyên khối (`src/*.integration`) | 7 | 49 | Service wallet hoặc payment chạy thật cùng worker, broker, restart |
| Packages (`packages/*`) | 7 | 42 | Messaging với RabbitMQ thật, công cụ test dùng chung |
| Migration (`*-migration`, `db/payment`) | 5 | 28 | Migration DB, nâng cấp tenant đã có dữ liệu |
| E2E trong process | 1 | 5 | Xem 2.4 |
| Contract provider | 1 | 2 | Xem 2.3 |

- **Kiểm được:** hành vi đúng của code với DB và broker thật: đồng thời, idempotency, khóa, rollback, ràng buộc tenant.
- **Không kiểm được:** stack đã deploy (cổng, compose, biến môi trường), thời gian thật (đồng hồ giả), hạ tầng bị tác động bằng tay, Kibana.

### 2.3 Contract (Pact)

- **Là gì:** kiểm hợp đồng giữa wallet và ecommerce về sự kiện RabbitMQ (wallet là consumer của `OrderReadyForPaymentV1`, provider của `OrderPaidV1` và `OrderPaymentFailedV1`).
- **Nhận diện:** `services/wallet/src/contract/wallet-consumer.pact.test.ts` (unit) và `wallet-provider.pact.integration.test.ts` (integration); fixture `services/wallet/pact-fixtures/`; pact sinh ra vào `pacts/`.
- **CI:** chỉ chạy khi job định nghĩa `PACT_BROKER_BASE_URL`; `can-i-deploy` mặc định chỉ cảnh báo (`PACT_ENFORCE_CAN_I_DEPLOY=false`).
- **Số lượng:** 2 file, 4 test (đếm tĩnh); trong lần chạy thật, consumer chạy trong bộ unit (2 test) và provider trong bộ integration (2 test).
- **Không kiểm được:** phía ecommerce chưa verify pact (theo ghi chú trong `Jenkinsfile`).

### 2.4 E2E trong process

- **Là gì:** wallet và payment cùng chạy trong một process test với DB thật, kiểm nạp tiền, đồng thời, tenant, ví đóng băng, sổ cái cân.
- **Nhận diện:** `tests/e2e/billing.integration.test.ts`. Do đuôi `integration`, repo xếp nó vào bộ integration.
- **Số lượng:** 1 file, 5 test (chạy thật).
- **Không kiểm được:** stack đã deploy, RabbitMQ thật, Orders thật.

### 2.5 Chaos

- **Là gì:** cố ý làm hỏng SQL Server, RabbitMQ, đường HTTP giữa hai service và tiến trình dịch vụ, rồi kiểm 8 bất biến về tiền bằng một "oracle" dùng chung. Hạ tầng dựng riêng bằng container, không dùng `billing-local`.
- **Nhận diện / lệnh:** `tests/chaos/*.chaos.test.ts`; `pnpm test:chaos`; cấu hình `vitest.chaos.config.ts`.
- **CI:** không thấy trong `Jenkinsfile`.
- **Số lượng:** 10 file, 130 test (đếm tĩnh; chưa chạy trong lần đo này). Trong 10 file này, 5 file là kịch bản và kiểm bất biến (`invariants`, `scenarios-ops-retention`, `scenarios-payment-crash`, `scenarios-sql-broker`, `soak.chaos` một vòng ngắn) và 5 file kiểm chính hạ tầng chaos (`support/broker-faults`, `crash`, `harness.smoke`, `sql-faults`, `system-harness`, cùng đuôi `.chaos.test.ts` nên chạy bằng `pnpm test:chaos`).
- **Kiểm được:** lỗi chính xác đến từng câu lệnh SQL hoặc từng commit (kill session đúng lúc, consumer chết sau commit trước ack, mất webhook...).
- **Không kiểm được:** độ trễ thật (backoff, lease), stack đã deploy.

### 2.6 Soak

- **Là gì:** tải ngẫu nhiên kèm lỗi ngẫu nhiên trong thời gian dài, kiểm các bất biến.
- **Nhận diện / lệnh:** `tests/chaos/soak-long.soak.test.ts`; `pnpm test:chaos:soak`; `vitest.chaos-soak.config.ts`. Ngoài ra `soak.chaos.test.ts` (một vòng ngắn, seed cố định) thuộc loại chaos.
- **CI / số lượng:** không thấy trong `Jenkinsfile`; 1 file, 1 test (đếm tĩnh).

### 2.7 Perf

- **Là gì:** đo hiệu năng và tranh chấp khóa của các kịch bản (nạp tiền, trả order, hỗn hợp) ở nhiều mức đồng thời, trên SQL Server trong container. Mỗi lượt đo kéo dài nhiều phút.
- **Nhận diện / lệnh:** `tests/perf/*.perf.test.ts`; `pnpm test:perf`; `vitest.perf.config.ts`. Tài liệu kết quả đo ở `docs/perf/`.
- **CI / số lượng:** không thấy trong `Jenkinsfile`; 10 file, 27 test (đếm tĩnh; chưa chạy).
- **Lưu ý:** tài liệu QA cũ từng ghi repo không có test performance; hiện đã có.

### 2.8 Test của công cụ và của DB (`tools/`, `db/`, công cụ chaos/perf)

Các file `*.test.ts` (đuôi unit) kiểm chính công cụ hỗ trợ được tách thành nhóm riêng để không lẫn với test sản phẩm; chúng chạy trong bộ unit (`pnpm test`). Test migration của `db/` là một file integration (xem thêm 2.2):

| Nhóm | Vị trí | File | Test (chạy thật) | Kiểm gì |
| --- | --- | --- | --- | --- |
| Công cụ vận hành và kiến trúc | `tools/*.test.ts`, `tools/kibana/*.test.ts`, `tools/local/*.test.ts` | 13 | 181 | Dựng và kiểm quy tắc, dashboard Kibana; dữ liệu mẫu; tài liệu handoff; khởi tạo RabbitMQ; **kiểm ranh giới kiến trúc** (`tools/boundaries.test.ts`: domain không được import infrastructure, v.v.) |
| `db/` migration payment | `db/payment/migrations.integration.test.ts` (bộ integration) | 1 | 6 (đếm tĩnh; nằm trong nhóm Migration ở 2.2) | Migration áp dụng một lần và chạy lại không đổi, tạo 4 bảng, các chỉ mục cho worker và phân trang sao kê, chỉ mục retention, so sánh khóa idempotency phân biệt hoa thường, ràng buộc CHECK. Hai script chạy migration bằng lệnh (`db/payment/migrate.ts`, `db/wallet/migrate.ts`) không có test |
| Công cụ chaos | `tests/chaos/support/*.test.ts` không có đuôi `.chaos` | 11 | 92 | Bộ sinh số ngẫu nhiên, kế hoạch tiêm lỗi, proxy HTTP, kiểm bất biến |
| Công cụ perf | `tests/perf/support/*.test.ts` và các file perf không có đuôi `.perf` | 9 | 96 | Bộ đo, bộ lấy mẫu, dựng dữ liệu |

### 2.9 Bộ Postman (tài sản QA, không phải test của dev)

- `docs/QA/postman/billing.postman_collection.json`: 487 request (đếm tĩnh), gồm `Smoke`, `Regression`, `EndPoints` cho wallet, payment, ops, reconciliations, `Chaos` và `E2E`.
- Chạy bằng Postman hoặc Newman vào **stack đã deploy**. Không nằm trong CI của `Jenkinsfile`.

## 3. Loại không có trong repo

Tìm bằng từ khóa trong toàn bộ file đã track (trừ `pnpm-lock.yaml`):

| Loại | Cách tìm | Kết quả |
| --- | --- | --- |
| Test UI / trình duyệt | `playwright`, `cypress`, `selenium`, `puppeteer`, `webdriver` | Không có (repo không có giao diện người dùng) |
| Load test bằng công cụ chuyên dụng | `k6`, `artillery`, `autocannon`, `jmeter`, `gatling` | Không có công cụ chuyên dụng trong source; hiệu năng đo bằng bộ perf tự viết (mục 2.7) |
| Quét bảo mật tự động (OWASP ZAP, Snyk, Trivy, Semgrep...) | từ khóa tương ứng | Không có |
| Mutation test | `stryker`, "mutation test" | Không có |
| Đặc tả API (OpenAPI/Swagger) | tên file `openapi`, `swagger` | Không có |
| Test chạy vào stack đã deploy | — | Không có trong test của dev. Chỉ có bộ Postman của QA (mục 2.9) |

## 4. Cách đếm và giới hạn

- **Số file** đếm bằng `git ls-files '*.test.ts'` rồi xếp loại theo đuôi tên file: unit 99, integration 64, chaos 10, soak 1, perf 10 (tổng 184).
- **Số test "đếm tĩnh"** đếm khối `it(`/`test(` (kể cả `.each`) bằng biểu thức chính quy: unit 663, integration 529, chaos 130, soak 1, perf 27. Cách này **thấp hơn** thực tế khi `it.each` sinh nhiều test; không phản ánh test bị bỏ qua (không thấy `skip`, `only`, `todo` nào trong các file này).
- **Số test "chạy thật"** lấy từ báo cáo JSON của Vitest: unit 1034, integration 609. Chaos, soak, perf **chưa chạy** trong lần đo này nên chỉ có số đếm tĩnh.
- **Cách xếp loại:** theo đuôi tên file, đúng cách repo tách cấu hình. Các trường hợp mơ hồ được xử lý như sau: e2e xếp riêng nhưng nằm trong bộ integration; contract xếp riêng nhưng consumer chạy trong unit, provider chạy trong integration; test của công cụ chaos/perf/tools xếp riêng khỏi test sản phẩm.
- **Lần chạy lại để kiểm cách đếm:** đếm số file bằng `git ls-files` hai lần cho cùng kết quả (99 và 64); số test chạy thật khớp với báo cáo Vitest (1034 và 609).
