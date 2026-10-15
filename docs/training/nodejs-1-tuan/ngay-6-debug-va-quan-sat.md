# Ngày 6: Debug và quan sát (log, correlation id, metric, Kibana)

Khung 4 giờ: Chuẩn bị 30' · Lý thuyết 45' · Đọc code 45' · Thực hành 90' · Thử thách 20' · Kiểm tra 10'.
Ngày này cần **Docker Desktop** cho phần chạy stack local. Phần debugger cần **VS Code** của bạn: tác giả chưa chạy thử (không có VS Code ở môi trường biên soạn), nên mọi bước debugger là [CHƯA CHẠY]; ghi lại sai khác để cập nhật giáo trình.

## Mục tiêu hôm nay
- Gắn debugger vào một test và một service, đặt breakpoint, đọc call stack và biến.
- Đọc log JSON của `pino`, lần theo một request bằng `correlationId`.
- Hiểu đường đi metric: service → OTel Collector → Elasticsearch → Kibana rule/dashboard.
- Dựng và kiểm tra stack local (`compose.local.yml`).

## Chuẩn bị
1. `git switch -c hoc/ngay-6`.
2. Copy `deploy/.env.example` thành `deploy/.env` (PowerShell: `Copy-Item deploy/.env.example deploy/.env`) và điền các mật khẩu mẫu theo bảng trong `docs/ops/local-stack.vi.md` (mật khẩu SQL Server phải đủ mạnh; `KIBANA_ENCRYPTION_KEY` tối thiểu 32 ký tự).
3. Docker Desktop cần đủ RAM cho SQL Server + Elasticsearch (heap mặc định `-Xms512m -Xmx512m`, `local-stack.vi.md`). Lần đầu build có thể mất nhiều phút.

## Lý thuyết

### 1. Debug Node
- Node có **Inspector** (giao thức Chrome DevTools). Bật bằng cờ `--inspect` (chạy rồi cho gắn) hoặc `--inspect-brk` (dừng ở dòng đầu). [ĐÃ CHẠY] `node --inspect=127.0.0.1:9339 --import tsx <file>.ts` in `Debugger listening on ws://127.0.0.1:9339/...` rồi chạy tiếp.
- VS Code gắn vào Inspector. Cách đơn giản nhất: Command Palette → **"Debug: JavaScript Debug Terminal"**, chạy lệnh trong terminal đó, các process Node con tự gắn debugger. [CHƯA CHẠY]
- Cấu hình `launch.json` mẫu để chạy một file test (chép vào `.vscode/launch.json`, **không có sẵn trong repo**). [CHƯA CHẠY]
  ```json
  {
    "version": "0.2.0",
    "configurations": [
      {
        "type": "node",
        "request": "launch",
        "name": "vitest: file hiện tại",
        "autoAttachChildProcesses": true,
        "skipFiles": ["<node_internals>/**"],
        "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
        "args": ["run", "${relativeFile}", "--no-file-parallelism"],
        "smartStep": true,
        "console": "integratedTerminal"
      }
    ]
  }
  ```
- **Source map**: code chạy qua `tsx` nên stack trace và breakpoint trỏ về file `.ts`. [GIẢ THUYẾT: cần xác nhận breakpoint trúng đúng dòng khi chạy thật.]
- Với `kysely`/`amqplib` bạn có thể `step into` vào `node_modules` — dùng `skipFiles` để tránh.

### 2. Log có cấu trúc
`createLogger(service)` (`packages/observability/src/logger.ts:4-13`) dùng `pino`: mỗi dòng là một JSON, có `service`, và hàm `mixin` tự thêm `correlationId` lấy từ `AsyncLocalStorage` (`logger.ts:7-10`, `correlation.ts`).
- HTTP: `CorrelationMiddleware` nhận hoặc sinh `x-correlation-id` (chỉ chấp nhận UUID hợp lệ, nếu không thì sinh mới: `correlation.ts:6,17-19`), trả lại ở response header và bọc phần xử lý trong `runWithCorrelation` (`correlation.middleware.ts:11-15`).
- Event: `correlationId` đi cùng trong payload (`events.ts` trường chung) và trong `PayOrderInput.correlationId` (`pay-order.ts:20`). **Phát hiện khi đọc code** [ĐÃ CHẠY: `grep runWithCorrelation` trên mã nguồn không phải test]: chỉ có hai nơi gọi nó — `services/wallet/src/interface/http/correlation.middleware.ts:14` và `services/payment/src/interface/http/app.ts:32`. Không thấy trong `packages/messaging` hay handler consumer của wallet, nên log do consumer ghi (ví dụ `order-ready.handler.ts:63-72`) **không** có `correlationId` tự động; chúng chỉ có `orderId`/`eventId`. Hãy lần theo bằng `orderId`/`eventId`. Đây là quan sát từ code, chưa tái hiện trên stack chạy; cần đội dev xác nhận có chủ đích hay không.
- Lab [ĐÃ CHẠY]: `labs/correlation-log.ts` cho thấy dòng log trong `runWithCorrelation` có `correlationId`, kể cả sau `await`, dòng ngoài thì không.

### 3. Metric và cảnh báo
- `initTelemetry({ serviceName })` (`main.ts:23`): **không đặt `OTEL_EXPORTER_OTLP_ENDPOINT` thì telemetry là no-op** (comment `main.ts:22`; `Telemetry.enabled` ở `telemetry.ts:29-31`).
- Loại: Counter (`add`) và Gauge (`replace` toàn bộ mẫu; `telemetry.ts:21-24`). Danh sách metric và trường ES: `docs/ops/metric-fields.md` (ví dụ `billing.outbox.pending`, `billing.dlq.depth`, `billing.order_payments`).
- Rule/dashboard Kibana **sinh từ code** (`tools/kibana/*`, ADR-0011) với 9 rule (README repo). Tham số: `docs/ops/kibana-alerts-and-dashboard.vi.md`.

### 4. Hạ tầng local
`compose.local.yml` `include` hai file: `compose.infra.yml` và `compose.services.yml` (`local-stack.vi.md`). Cổng: wallet 3001, payment 3002, SQL Server 11433, RabbitMQ AMQP 15673, management 15674, Elasticsearch 19200, Kibana 15601, OTLP gRPC 14317; tất cả chỉ lắng nghe loopback `127.0.0.1`.

## Đọc code có hướng dẫn
1. `packages/observability/src/logger.ts`, `correlation.ts`, `telemetry.ts` (xem `noopTelemetry` dòng 41 và dòng 81).
2. `services/wallet/src/interface/http/correlation.middleware.ts` (16 dòng).
3. Tự lặp lại phép tìm: Ctrl+Shift+F từ khóa `runWithCorrelation` (bỏ file test) và đối chiếu với phát hiện ở mục Lý thuyết 2.
4. `docs/ops/local-stack.vi.md` (cả file, đặc biệt mục "Sự cố thường gặp" nếu có) và `docs/ops/kibana-alerts-and-dashboard.vi.md`.
5. `docs/ops/metric-fields.md`: bảng trường ES và ES|QL mẫu.

## Thực hành
1. [ĐÃ CHẠY] Lab log: `.\node_modules\.bin\tsx docs/training/nodejs-1-tuan/labs/correlation-log.ts` và giải thích từng dòng.
2. [CHƯA CHẠY] **Breakpoint trong test**: mở `packages/runtime/src/worker.test.ts`, đặt breakpoint ở `worker.ts:22` (`await task(signal)`), chạy cấu hình `vitest: file hiện tại`. Quan sát `signal.aborted`, `this.options.tasks`, call stack.
3. [CHƯA CHẠY] **Breakpoint trong luồng tiền**: đặt breakpoint ở `pay-order.ts:83` (`inbox.record`) và `pay-order.ts:149` (`ledger.post`), chạy `pay-order.integration.test.ts` (cần Docker) trong Debug Terminal: `corepack pnpm test:integration pay-order`. Xem `repositories` truyền vào `pay` (`pay-order.ts:69-70`).
4. [CHƯA CHẠY] **Dựng stack local**:
   ```powershell
   docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/compose.local.yml --env-file deploy/.env ps -a
   curl.exe -s http://localhost:3001/health
   curl.exe -s http://localhost:3002/health
   corepack pnpm local:seed
   corepack pnpm kibana:verify
   ```
   (PowerShell: dùng `curl.exe`, vì `curl` là alias của `Invoke-WebRequest`.) Điều kiện đạt: xem "Đạt khi" trong `local-stack.vi.md`.
5. [CHƯA CHẠY] Mở Kibana `http://localhost:15601`: Rules (tag `billing`) và dashboard "Billing: vận hành". Tìm panel "DLQ depth".
6. **Sửa code để quan sát**: trong `order-ready.handler.ts` thêm `deps.log.info({ correlationId: event.correlationId }, 'trace')` trước khi gọi `payOrder.execute`; chạy `order-ready.handler.test.ts`. Bỏ thay đổi sau khi xong (hoặc giữ trên nhánh học).

## Thử thách troubleshoot
**Tình huống A (quan sát)**: dashboard trống dù service chạy. Các nguyên nhân cần loại trừ, theo thứ tự: (1) `OTEL_EXPORTER_OTLP_ENDPOINT` có được đặt cho service không (không đặt → no-op)? (2) collector `Up` chưa (`ps -a`)? (3) job `kibana-import` đã `Exited (0)` chưa (`docker compose ... logs kibana-import`)? (4) đã `local:seed` chưa — một số metric (`billing.topups`, `billing.payment.charges`...) **chỉ xuất hiện khi có sự kiện** (`metric-fields.md`).
**Tình huống B (correlation)**: bạn có `correlationId` từ khách. Hãy liệt kê cách lần theo nó qua log HTTP của wallet/payment (middleware gắn tự động) và qua `orderId`/`eventId` ở phía consumer (vì consumer không gắn `correlationId` tự động). Luồng chéo service **cần bạn tự xác nhận** trên stack local.
**Tình huống C (khởi động)**: wallet thoát ngay với "invalid configuration, refusing to start" (`main.ts:16`). Log có `problems: [...]` liệt kê trường lỗi (ví dụ `WALLET_TENANTS is required`, `config.ts:95`). Việc cần làm: đọc `problems`, đối chiếu `services/wallet/.env.example`. Đây là hành vi **fail-fast** của `loadConfig`.

## Kiểm tra cuối ngày
1. `--inspect` và `--inspect-brk` khác nhau thế nào?
2. Vì sao `correlationId` xuất hiện trong log mà không cần truyền tay?
3. Telemetry không cấu hình thì service làm gì?
4. Vì sao PowerShell cần `curl.exe`?
5. Metric `billing.dlq.depth` do ai đo và bằng cách nào? (xem runbook DLQ)
6. Gauge `replace` khác counter `add` thế nào?
7. Ba nguyên nhân khiến wallet không khởi động mà log cho biết ngay?

### Đáp án
1. `--inspect` chạy ngay và chờ client gắn; `--inspect-brk` dừng ở dòng đầu (Node docs; phần `--inspect` [ĐÃ CHẠY]).
2. `AsyncLocalStorage` + `mixin` của `pino` (`logger.ts:7-10`, `correlation.ts:7`).
3. No-op, không ném lỗi (`main.ts:22`, `telemetry.ts:41,81`).
4. `curl` trong PowerShell là alias của `Invoke-WebRequest`.
5. Wallet đo bằng passive declare của queue (`docs/integration/dlq-runbook.vi.md`, mục "Giám sát"; code `broker-queue-depth.ts`).
6. `replace` thay toàn bộ mẫu — tập thuộc tính không còn trong danh sách ngừng được báo (`telemetry.ts:21-24`); `add` chỉ cộng dồn.
7. Cấu hình không hợp lệ (`main.ts:16`), thiếu migration/tenant (`bootstrap.ts:91` `assertMigrated`), không kết nối được broker (`bootstrap.ts:99-102`).

## Lỗi thường gặp khi chuyển từ .NET sang Node
- Tìm "Visual Studio attach to process": ở Node dùng Inspector/VS Code Debug Terminal.
- Log chuỗi tự do thay vì JSON: ở đây log là JSON để máy đọc.
- `try/catch` không bắt được lỗi của promise không `await`.

## Câu hỏi còn mở (cho đội dev)
- Log của consumer không có `correlationId` tự động (xem Lý thuyết 2): có chủ đích hay còn thiếu? Nếu cần, thêm `runWithCorrelation(event.correlationId, ...)` quanh `payOrder.execute` là một bài tập sửa code tốt, nhưng hãy xác nhận với đội dev trước khi đưa vào nhánh chính.
- Cách chạy `launch.json` cho từng service khi có `.env` (config đọc từ `process.env`, `main.ts:13`): đội dev dùng cách nào?
