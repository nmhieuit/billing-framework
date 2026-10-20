# Ngày 3 (thực hành): Debug `POST /topups` của wallet gọi bất đồng bộ sang payment, truy vết correlation id

Mục tiêu: đặt breakpoint và đi theo **một request nạp tiền** từ wallet sang payment và quay lại, trên **máy local (VS Code)** và trên **Docker Desktop**.
Khung 4 giờ: Setup 60' · Debug local 90' · Debug Docker 50' · Bài tập sửa code 30' · Kiểm tra 10'.

Quy ước nhãn: **[ĐÃ CHẠY]** = tác giả đã chạy và thấy kết quả (trong môi trường biên soạn: Linux, không Docker, không VS Code, không Windows); **[CHƯA CHẠY]** = chưa kiểm chứng; **[GIẢ THUYẾT]** = cần bạn xác nhận.

---

## 0. Điều quan trọng cần biết trước (đã kiểm chứng bằng code thật)

Bạn mô tả "gọi bất đồng bộ qua payment **có truyền** correlation id". Khi đọc và chạy code, kết quả là:

| Câu hỏi | Kết quả | Bằng chứng |
| ------- | ------- | ---------- |
| Wallet có nhận `x-correlation-id` từ client và gắn vào log không? | **Có** | `correlation.middleware.ts:11-15`, `logger.ts:7-10` |
| Giá trị đó có còn khi wallet chạy nền gửi sang payment (`submitSoon`, không await)? | **Có** (AsyncLocalStorage sống qua `await`) | lab C: `tp_http@sau await` vẫn thấy id |
| Wallet có **gửi** `x-correlation-id` sang payment? | **Không**. Header gửi đi chỉ có `content-type`, `idempotency-key` | `http-payment-gateway.ts:24-27`; lab A |
| Payment có nhận được nếu gửi? | **Có**: giữ nguyên id, echo ở response header | `payment/.../app.ts:29-33`; lab B |
| Payment không nhận header thì sao? | **Tự sinh UUID mới** (khác id của khách) | lab B |
| Đường **Worker** gửi lại (khi lần gửi ngay thất bại) có correlation id không? | **Không** (không có ngữ cảnh request) | lab C: `tp_worker` không có id |
| Payment gọi webhook về wallet có kèm correlation id không? | **Không**. Header: `content-type`, `x-signature`, `x-webhook-event-id` | `http-webhook-sender.ts:25-29` |

Lab chạy được, dùng code thật `HttpPaymentGateway`, payment `buildApp` (Fastify), `InlineTopupSubmitter`: [labs/correlation-propagation.ts](labs/correlation-propagation.ts) [ĐÃ CHẠY].

**Quyết định đã chốt:** không sửa code để truyền correlation id. Hướng dẫn này debug luồng **đúng như code hiện tại**:
- Correlation id chỉ dùng để lọc log **bên trong wallet** (phần HTTP và phần chạy nền khởi phát từ request).
- Khi sang payment và khi webhook quay về, bạn nối các hệ thống bằng **khóa có thật**: `topupId`, idempotency key `topup:<tenant>:<topupId>`, `chargeId`, `x-webhook-event-id` (xem Phần 5.4 và 6, có truy vấn SQL).
- Muốn lọc theo một lần nạp cụ thể khi debugger: dùng **conditional breakpoint** và **logpoint** theo `topupId` (Phần 5.5).

---

## 1. Luồng cần debug

```
Client ──POST /topups──▶ WALLET
  1 CorrelationMiddleware     correlation.middleware.ts:12   nhận/sinh correlation id
  2 CallerGuard               caller.guard.ts                đọc x-tenant-id, x-customer-id
  3 TopupsController.create   topups.controller.ts:57        gọi RequestTopup.execute
  4 RequestTopup.execute      request-topup.ts:80            await transaction: ví, topup, idempotency
  5 submitter.submitSoon      request-topup.ts:88            KHÔNG await (chạy nền)
  6 ◀── 202 {topupId} ────────────────────────────────────── client nhận trả lời tại đây
  ─── chạy nền ───
  7 InlineTopupSubmitter      inline-topup-submitter.ts:16   async IIFE -> SubmitTopup.executeFor
  8 SubmitTopup.submitClaimed submit-topup.ts:68             gateway.createCharge
  9 HttpPaymentGateway        http-payment-gateway.ts:22     fetch POST {PAYMENT_BASE_URL}/charges
        │  headers: content-type, idempotency-key=topup:<tenant>:<topupId>   (KHÔNG có x-correlation-id)
        ▼
PAYMENT
 10 onRequest hook            payment/.../app.ts:30          sinh correlation id MỚI
 11 POST /charges             charges.route.ts:55            CreateCharge.execute  (create-charge.ts:57)
 12 202 {chargeId}  ──▶ wallet ghi SUBMITTED  (submit-topup.ts:83)
  ─── worker của payment (setTimeout, mỗi WORKER_INTERVAL_MS) ───
 13 CompleteDueCharges        complete-due-charges.ts        hoàn tất charge + tạo webhook event
 14 DeliverDueWebhooks        deliver-due-webhooks.ts:61     sender.send
 15 HttpWebhookSender         http-webhook-sender.ts:22      POST WEBHOOK_URL (wallet /webhooks/payment)
        ▼
WALLET
 16 WebhooksController        webhooks.controller.ts:39,69   verify chữ ký -> ApplyPaymentResult.execute
```

Hai mảnh ghép đồng bộ/bất đồng bộ (Ngày 2): bước 4 là `await` (microtask khi DB trả lời), bước 5 là "bắn rồi quên" có `.catch/.finally`, bước 13–14 chạy bằng `Worker` (macrotask qua `setTimeout`).

---

## 2. Setup chung (làm một lần)

### 2.1. Công cụ
- Node 22, Docker Desktop (WSL2), VS Code, Git. Kiểm tra: `node -v`, `docker version`.
- `corepack pnpm install` ở gốc repo.
- VS Code: cài extension **ESLint** (tùy chọn). Trình debug Node có sẵn trong VS Code.
- Repo đã có `.vscode/launch.json` (bạn đã merge) với các cấu hình `Debug wallet-service`, `Debug payment-service`, `Attach to process (9229)`.

### 2.2. Tạo `deploy/.env`
Theo `docs/ops/local-stack.vi.md`:
```powershell
Copy-Item deploy/.env.example deploy/.env
```
Điền mật khẩu (SQL Server cần đủ mạnh: tối thiểu 8 ký tự, 3 trong 4 loại hoa/thường/số/ký hiệu). Các khóa dùng trong hướng dẫn này: `BILLING_WALLET_DB_PASSWORD`, `BILLING_PAYMENT_DB_PASSWORD`, `BILLING_WALLET_MIGRATOR_DB_PASSWORD`, `BILLING_PAYMENT_MIGRATOR_DB_PASSWORD`, `BILLING_SQLSERVER_SA_PASSWORD`, `BILLING_WALLET_MQ_PASSWORD`, `BILLING_PAYMENT_MQ_PASSWORD`, `BILLING_ECOMMERCE_MQ_PASSWORD`, `BILLING_RABBITMQ_ADMIN_PASSWORD`, `LOCAL_WEBHOOK_SECRET` (đã có mẫu). `deploy/.env` bị git bỏ qua (`.gitignore:4`).

### 2.3. Cổng trên máy chủ (mặc định, chỉ lắng nghe 127.0.0.1)
| Dịch vụ | Cổng | Biến |
| ------- | ---- | ---- |
| wallet | 3001 | `LOCAL_WALLET_PORT` |
| payment | 3002 | `LOCAL_PAYMENT_PORT` |
| SQL Server | **11433** | `LOCAL_SQL_PORT` |
| RabbitMQ AMQP | **15673** | `LOCAL_AMQP_PORT` |
| RabbitMQ management | 15674 | `LOCAL_RABBITMQ_MGMT_PORT` |
Nguồn: `deploy/compose.infra.yml`, `compose.services.yml`, `.env.example`.

---

## 3. Chế độ A: Debug LOCAL (wallet + payment chạy dưới debugger VS Code, hạ tầng trong Docker)

Đây là cách dễ nhất để đặt breakpoint: code chạy thẳng trên máy bạn, SQL Server và RabbitMQ chạy trong Docker.

### 3.1. Chỉ dựng hạ tầng + migration (không dựng wallet/payment trong Docker)
```powershell
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d migrate billing-rabbitmq-init
docker compose -f deploy/compose.local.yml --env-file deploy/.env ps -a
```
- `migrate` kéo theo `sqlserver` + `billing-sql-init` (`compose.services.yml`: `depends_on`); `billing-rabbitmq-init` kéo theo `rabbitmq`.
- Đạt khi: `sqlserver`, `rabbitmq` healthy; `billing-sql-init`, `billing-rabbitmq-init`, `migrate` ở trạng thái `Exited (0)`.
- Nếu trước đó bạn đã `up` cả stack: **dừng wallet/payment trong Docker**, nếu không sẽ trùng cổng 3001/3002 và **hai wallet cùng consume một hàng đợi RabbitMQ** (wallet trong Docker "ăn" message của bạn):
  ```powershell
  docker compose -f deploy/compose.local.yml --env-file deploy/.env stop wallet payment
  ```
[CHƯA CHẠY: cần Docker]

### 3.2. Tạo file biến môi trường cho debugger
`tsx` **không** đọc `.env`; service đọc thẳng `process.env` (`wallet/src/main.ts:13`), nên cấu hình `Debug wallet-service` hiện có sẽ thoát ngay với "invalid configuration, refusing to start" nếu thiếu biến (`main.ts:16`). Dùng thuộc tính `envFile` của launch.json.

Tạo `deploy/wallet.debug.env` (thay `<...>` bằng giá trị trong `deploy/.env`):
```
WALLET_DB_HOST=localhost
WALLET_DB_PORT=11433
WALLET_DB_NAME=billing_wallet
WALLET_DB_USER=billing_wallet_app
WALLET_DB_PASSWORD=<BILLING_WALLET_DB_PASSWORD>
WALLET_TENANTS=acme,beta
PAYMENT_BASE_URL=http://localhost:3002
PAYMENT_WEBHOOK_SECRET=<LOCAL_WEBHOOK_SECRET>
RABBITMQ_HOST=localhost
RABBITMQ_PORT=15673
RABBITMQ_VHOST=billing
RABBITMQ_USER=billing_wallet
RABBITMQ_PASSWORD=<BILLING_WALLET_MQ_PASSWORD>
PORT=3001
WORKER_INTERVAL_MS=500
```
Tạo `deploy/payment.debug.env`:
```
PAYMENT_DB_HOST=localhost
PAYMENT_DB_PORT=11433
PAYMENT_DB_NAME=billing_payment
PAYMENT_DB_USER=billing_payment_app
PAYMENT_DB_PASSWORD=<BILLING_PAYMENT_DB_PASSWORD>
WEBHOOK_URL=http://localhost:3001/webhooks/payment
WEBHOOK_SECRET=<LOCAL_WEBHOOK_SECRET>
PORT=3002
WORKER_INTERVAL_MS=500
```
Tên biến lấy từ `services/wallet/.env.example` và `services/payment/.env.example`; không đặt `OTEL_EXPORTER_OTLP_ENDPOINT` nên telemetry là no-op (`main.ts:22`).

**Cảnh báo bí mật:** `.gitignore` chỉ bỏ qua đúng tên `.env`, **không** bỏ qua `deploy/*.debug.env` [ĐÃ CHẠY `git check-ignore`]. Thêm quy tắc chỉ-cục-bộ để không lỡ commit:
```powershell
Add-Content .git/info/exclude "deploy/*.debug.env"
```

### 3.3. Thêm cấu hình vào `.vscode/launch.json`
Thêm hai cấu hình mới (giữ nguyên các cấu hình cũ) và một `compound` để chạy cả hai cùng lúc. Trong mảng `configurations`:
```json
{
  "name": "Debug wallet-service (envFile)",
  "type": "node",
  "request": "launch",
  "cwd": "${workspaceFolder}/services/wallet",
  "runtimeExecutable": "node",
  "runtimeArgs": ["--import", "tsx"],
  "program": "${workspaceFolder}/services/wallet/src/main.ts",
  "envFile": "${workspaceFolder}/deploy/wallet.debug.env",
  "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
  "console": "integratedTerminal"
},
{
  "name": "Debug payment-service (envFile)",
  "type": "node",
  "request": "launch",
  "cwd": "${workspaceFolder}/services/payment",
  "runtimeExecutable": "node",
  "runtimeArgs": ["--import", "tsx"],
  "program": "${workspaceFolder}/services/payment/src/main.ts",
  "envFile": "${workspaceFolder}/deploy/payment.debug.env",
  "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
  "console": "integratedTerminal"
}
```
và thêm khối `compounds` cùng cấp với `configurations`:
```json
"compounds": [
  {
    "name": "Wallet + Payment (envFile)",
    "configurations": ["Debug payment-service (envFile)", "Debug wallet-service (envFile)"],
    "stopAll": true
  }
]
```
Thứ tự: payment khởi động trước (wallet gọi payment). [CHƯA CHẠY: cần VS Code. Kiểm chứng đã làm: `node --inspect --import tsx` mở được cổng debug, xem Ngày 6.]

### 3.4. Khởi chạy
1. Ctrl+Shift+D (Run and Debug) → chọn **Wallet + Payment (envFile)** → F5.
2. Terminal tích hợp hiện hai tab. Thành công khi thấy `wallet service listening` (`wallet/src/main.ts:32-35`) và `payment service listening` (`payment/src/main.ts:31`).
3. Kiểm tra: `curl.exe -s http://localhost:3001/health` và `http://localhost:3002/health`.

---

## 4. Chế độ B: Debug trong Docker Desktop (attach vào container)

Dùng khi bạn muốn debug đúng môi trường container (mạng nội bộ `wallet` → `http://payment:3002`).

### 4.1. Cách chạy nền tảng (chỉ xem log, không debugger)
```powershell
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.local.yml --env-file deploy/.env logs -f wallet payment
```
Log là JSON một dòng mỗi sự kiện (pino) nên lọc bằng chuỗi:
```powershell
docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet payment | Select-String "<correlation-id>"
```

### 4.2. Bật cổng debug (override compose)
Trong `compose.services.yml`, wallet/payment chạy `corepack pnpm --filter ... dev` (= `tsx watch`) và bind-mount **mã nguồn** từ máy bạn vào `/app/...` ở chế độ chỉ đọc (`x-sources`). Để gắn debugger cần chạy `node --inspect` thay cho `tsx watch`.

Tạo `deploy/compose.debug.yml` (file local của bạn):
```yaml
services:
  wallet:
    command: ['node', '--inspect=0.0.0.0:9229', '--import', 'tsx', 'services/wallet/src/main.ts']
    ports: ['127.0.0.1:9229:9229']
  payment:
    command: ['node', '--inspect=0.0.0.0:9229', '--import', 'tsx', 'services/payment/src/main.ts']
    ports: ['127.0.0.1:9230:9229']
```
- `working_dir` của image là `/app` (`compose.services.yml`, `x-dev`), nên đường dẫn `services/wallet/src/main.ts` đúng.
- Cổng 9229 chỉ publish ra `127.0.0.1` của máy bạn (không ra mạng LAN), phù hợp quy ước loopback của stack (`local-stack.vi.md`). **Không** publish cổng inspector ra mạng.
- Khởi động với hai file:
  ```powershell
  docker compose -f deploy/compose.local.yml -f deploy/compose.debug.yml --env-file deploy/.env config   # xem cấu hình sau khi gộp
  docker compose -f deploy/compose.local.yml -f deploy/compose.debug.yml --env-file deploy/.env up -d wallet payment
  ```
- **[CHƯA CHẠY]** và **[GIẢ THUYẾT]**: `compose.local.yml` dùng `include`; tôi chưa kiểm chứng việc gộp thêm file `-f` lên service được `include` trên máy của bạn. Bước `config` ở trên để xác nhận: nếu `wallet.command` không hiện `--inspect`, hãy báo lại để đổi cách làm.
- Khác với `tsx watch`, lệnh `node ...` **không tự nạp lại** khi bạn sửa code: sau khi sửa, chạy `docker compose ... restart wallet payment`.

### 4.3. Cấu hình attach trong `launch.json`
Cấu hình `Attach to process (9229)` chỉ gắn cổng, không có ánh xạ đường dẫn container ↔ máy. Repo đã có sẵn hai cấu hình attach đúng ánh xạ (`.vscode/launch.json`):
```json
{
  "name": "Attach wallet (Docker)",
  "type": "node",
  "request": "attach",
  "address": "localhost",
  "port": 9229,
  "localRoot": "${workspaceFolder}",
  "remoteRoot": "/app",
  "restart": true,
  "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
},
{
  "name": "Attach payment (Docker)",
  "type": "node",
  "request": "attach",
  "address": "localhost",
  "port": 9230,
  "localRoot": "${workspaceFolder}",
  "remoteRoot": "/app",
  "restart": true,
  "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
}
```
`remoteRoot: /app` khớp bind mount `../services/wallet/src:/app/services/wallet/src` (`compose.services.yml` `x-sources`). Cùng file đã có compound **`Attach wallet + payment (Docker)`** để gắn vào cả hai container bằng một lần F5 (mục 4.5). [CHƯA CHẠY]

### 4.4. Gắn debugger
1. Đảm bảo log container có dòng `Debugger listening on ws://0.0.0.0:9229/...`: `docker compose ... logs wallet | Select-String "Debugger"`.
2. F5 với **Attach wallet (Docker)**; thanh debug hiện, breakpoint chuyển từ xám sang đỏ.
3. Nếu breakpoint giữ màu xám: kiểm tra `remoteRoot`/`localRoot`, hoặc mở Debug Console xem thông báo. Chụp màn hình lỗi gửi lại.

### 4.5. Debug wallet và payment cùng lúc trong Docker (compound)

`.vscode/launch.json` có compound `Attach wallet + payment (Docker)` = `Attach payment (Docker)` (cổng 9230) + `Attach wallet (Docker)` (cổng 9229), `stopAll: true`. Payment gắn trước vì wallet gọi payment.

Checklist tự xác nhận trên máy bạn [CHƯA CHẠY: cần Docker Desktop và VS Code]:
1. Xem cấu hình sau khi gộp: `docker compose -f deploy/compose.local.yml -f deploy/compose.debug.yml --env-file deploy/.env config`. `wallet.command` và `payment.command` phải chứa `--inspect=0.0.0.0:9229`. Nếu không, báo lại (việc gộp `-f` với `include` chưa được kiểm chứng).
2. Khởi động: `docker compose -f deploy/compose.local.yml -f deploy/compose.debug.yml --env-file deploy/.env up -d --build wallet payment`.
3. Log mỗi container có `Debugger listening on ws://0.0.0.0:9229/...`: `docker compose ... logs wallet payment | Select-String "Debugger"`.
4. Ctrl+Shift+D, chọn `Attach wallet + payment (Docker)`, F5. Panel Call Stack liệt kê **hai** phiên debug.
5. Đặt hai breakpoint: `services/wallet/src/application/request-topup.ts:88` và `services/payment/src/application/create-charge.ts:57`.
6. Gửi `POST /topups` (mục 5.2). Debugger dừng ở wallet; F5 tiếp tục, rồi dừng ở payment: **cả hai gắn đúng**.
7. Shift+F5 ngắt cả hai phiên (`stopAll`). Container vẫn chạy.

Xử lý sự cố: cổng 9229/9230 đã dùng (tắt stack cũ); breakpoint xám (kiểm tra `remoteRoot: /app`, hoặc đã sửa code mà chưa `docker compose ... restart wallet payment`); chỉ một phiên gắn được (container còn lại chưa chạy `--inspect`: xem bước 1 và 3). `restart: true` giúp debugger tự gắn lại khi container khởi động lại.

---

## 5. Step by step: debug một lần nạp tiền

Dùng cho cả Chế độ A và B (đổi cổng nếu bạn đổi biến `LOCAL_*_PORT`).

### 5.1. Đặt breakpoint (theo thứ tự luồng)
| # | File:dòng | Quan sát gì |
| - | --------- | ----------- |
| 1 | `services/wallet/src/interface/http/correlation.middleware.ts:12` | `req.headers['x-correlation-id']`, giá trị `correlationId` sau khi `resolveCorrelationId` |
| 2 | `.../topups.controller.ts:57` | `caller.tenant`, `idempotencyKey`, `amount` |
| 3 | `services/wallet/src/application/request-topup.ts:88` | trước `submitSoon`; `result.replayed` phải `false` ở lần đầu |
| 4 | `.../inline-topup-submitter.ts:16` | bên trong IIFE chạy nền; xem Call Stack (khung async) |
| 5 | `.../submit-topup.ts:68` | `props.id` (= `topupId`), `idempotencyKey` sắp gửi |
| 6 | `services/wallet/src/infrastructure/http-payment-gateway.ts:22` | thêm **Watch**: `getCorrelationId()` — đang là id của khách; xem `headers` ngay trên dòng 22 |
| 7 | `services/payment/src/interface/http/app.ts:30` | `request.headers['x-correlation-id']` (đang `undefined`) và `correlationId` mới sinh |
| 8 | `services/payment/src/application/create-charge.ts:57` | `input.idempotencyKey`, `input.reference` (= topupId), `metadata.tenantId` |
| 9 | `services/payment/src/application/deliver-due-webhooks.ts:61` | worker payment bắt đầu gửi webhook; `event.toProps()` |
| 10 | `services/wallet/src/interface/http/webhooks.controller.ts:69` | wallet nhận webhook; `payload.data.reference` = topupId |
| 11 | `services/wallet/src/application/submit-topup.ts:83` | `result.chargeId` ghi vào topup (`SUBMITTED`) |

Chú ý: đặt breakpoint ở dòng 5, 6, 8 sẽ **giữ giao dịch DB mở** khi bạn dừng (khóa lease ngắn: `DEFAULT_LEASE_SECONDS = 60`, `submit-topup.ts:16`). Dừng quá lâu có thể làm worker lấy lại lần nạp. Nếu thấy hành vi lạ, tiếp tục (F5) rồi thử lại nhanh hơn.

### 5.2. Tạo ví rồi gửi yêu cầu nạp
PowerShell (dùng `curl.exe`, không dùng `curl`):
```powershell
$cid = [guid]::NewGuid().ToString()
$cid   # ghi lại để tìm trong log

# 1) tạo ví (lần đầu)
curl.exe -i -X POST http://localhost:3001/wallets `
  -H "x-tenant-id: acme" -H "x-customer-id: dbg1" -H "x-correlation-id: $cid" `
  -H "content-type: application/json" -d '{\"currency\":\"VND\"}'

# 2) yêu cầu nạp 50.000 VND
curl.exe -i -X POST http://localhost:3001/topups `
  -H "x-tenant-id: acme" -H "x-customer-id: dbg1" -H "x-correlation-id: $cid" `
  -H "Idempotency-Key: dbg-1" -H "content-type: application/json" -d '{\"amount\":50000}'
```
[CHƯA CHẠY trên Windows. Nếu PowerShell làm hỏng dấu nháy JSON, ghi nội dung ra file `body.json` rồi dùng `-d "@body.json"`.]
- Header phản hồi phải có `x-correlation-id: <cid>` (`correlation.middleware.ts:13`).
- Mã trả về `202` và body có `topupId` (`topups.controller.ts:43`, `views.ts`).
- Đầu vào hợp lệ: tenant phải nằm trong `WALLET_TENANTS` (`acme`, `beta`), customer id khớp `^[A-Za-z0-9_-]{1,64}$` (`customer-id.ts`).

### 5.3. Đi từng bước (F5 / F10 / F11)
1. **Dừng ở #1** (`correlation.middleware.ts:12`): Variables cho thấy header bạn gửi. F10 qua dòng 13–14 rồi F5.
2. **#2 → #3**: F10 qua `await this.requestTopup.execute`. Quan sát: lần F10 đi qua `await` "nhảy" sang code khác (Ngày 2: phần sau `await` là microtask).
3. **#3** (`request-topup.ts:88`): `result.body.topupId` là mã bạn sẽ dùng để theo dõi. F10 một lần: dòng `submitSoon` **trả về ngay**.
4. **Quan sát #4 trước khi client nhận 202**: với breakpoint ở `inline-topup-submitter.ts:16`, trình debug dừng **trước khi** controller trả 202 (đúng như lab Ngày 2: phần đồng bộ của việc chạy nền chạy ngay). Call Stack có khung `submitSoon`.
5. **#5 → #6**: F5 đến `http-payment-gateway.ts:22`. Xem biến `headers` (đối tượng literal ở dòng 24–27): chỉ có hai khóa `content-type`, `idempotency-key`. **Không có** `x-correlation-id`. (Lab C đã chứng minh `getCorrelationId()` ở thời điểm này vẫn trả id của khách trong wallet, nhưng id đó không được đưa vào request.)
6. **#7** (payment `app.ts:30`): `request.headers['x-correlation-id']` là `undefined`; sau `resolveCorrelationId` biến `correlationId` là UUID **mới** — khác id của khách.
7. **#8** (`create-charge.ts:57`): `input.reference` = `topupId` ở wallet; `input.idempotencyKey` = `topup:acme:<topupId>` (`submit-topup.ts:69`). **Đây là khóa nối hai hệ thống hiện nay.**
8. Quay lại **#11**: sau khi payment trả `202 {chargeId}`, `topups.save(current.recordSubmitted(...))`. Gọi `GET /topups/<topupId>` để xem trạng thái (xem trường `status`).
9. Chờ worker payment (chu kỳ `WORKER_INTERVAL_MS`, mặc định 500ms trong compose): **#9** dừng ở `deliver-due-webhooks.ts:61`, rồi **#10** dừng ở `webhooks.controller.ts:69` trên wallet. Ở request webhook này, `correlation.middleware.ts` sinh một id **khác nữa** (payment không gửi header).
10. Kết quả cuối: `GET /topups/<topupId>` → trạng thái chốt (ví dụ `SUCCEEDED`), `GET /wallet/entries` có dòng sổ cái (`ledger-transaction.ts:73`, khóa `topup:<topupId>`). Chi tiết trạng thái: [GIẢ THUYẾT: bạn quan sát và ghi lại tên trạng thái thực tế].

### 5.4. Bảng khóa nối wallet ↔ payment (thay cho correlation id)
| Hệ thống | Khóa tìm trong log / DB | Nguồn trong code |
| -------- | ----------------------- | ---------------- |
| Wallet HTTP | `x-correlation-id` do khách gửi (chỉ trong wallet) | `correlation.middleware.ts:12` |
| Wallet | `topups.id` = `topupId` | `request-topup.ts:58`, `002-topups.ts` |
| Wallet → payment | `idempotency-key: topup:<tenant>:<topupId>`; body `reference` = `topupId`; `metadata.tenantId` | `submit-topup.ts:69-72` |
| Payment | `charges.reference` = `topupId`, `charges.id` = `chargeId` | `create-charge.ts:57-63`, `db/payment/001-init.ts` |
| Payment → wallet | `webhook_events.event_id` (header `x-webhook-event-id`), `payload.data.reference` = `topupId` | `http-webhook-sender.ts:25-29`, `webhooks.controller.ts:69-78` |
Log của `SubmitTopup` chỉ ghi khi lỗi hoặc retry (`submit-topup.ts:116-132`); thành công thì **không có dòng log**, hãy xác nhận bằng debugger hoặc SQL.

### 5.5. Lọc theo một lần nạp khi debugger: conditional breakpoint và logpoint
Khi nhiều request chạy cùng lúc, dừng ở mọi request là khó theo dõi. VS Code cho phép:
- **Conditional breakpoint:** chuột phải vào lề trái cạnh số dòng → *Add Conditional Breakpoint…* → *Expression*. Ví dụ tại `submit-topup.ts:68`:
  ```
  props.id === 'tp_xxxxx'
  ```
  (thay bằng `topupId` bạn nhận ở bước 5.2; lấy từ response `202`). Tại `webhooks.controller.ts:69`: `payload.data.reference === 'tp_xxxxx'`. Tại `create-charge.ts:57`: `input.reference === 'tp_xxxxx'`.
- **Logpoint:** chuột phải → *Add Logpoint…*, nhập thông điệp có biểu thức trong `{}`, ví dụ `submit topup {props.id} key={'topup:' + tenant.value + ':' + props.id}`. Không dừng chương trình, chỉ in ra Debug Console.
[CHƯA CHẠY: cần VS Code. Đây là tính năng chuẩn của VS Code.] Biến `props`, `tenant`, `input`, `payload` là các biến cục bộ có tên đúng như trong code ở các dòng nêu trên.

### 5.6. Truy vết bằng SQL (không cần sửa code)
Dùng extension **SQL Server (mssql)** của Microsoft trong VS Code (ID `ms-mssql.mssql`), kết nối `localhost,11433`. Hoặc dùng `sqlcmd` trong container (đường dẫn công cụ lấy từ healthcheck, `compose.infra.yml:24-27`):
```powershell
docker compose -f deploy/compose.local.yml --env-file deploy/.env exec sqlserver /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -d billing_wallet -P "<BILLING_SQLSERVER_SA_PASSWORD>" -Q "SELECT id, status, charge_id, attempts, next_attempt_at, completed_at FROM t_acme.topups WHERE id = 'tp_xxxxx'"
```
[CHƯA CHẠY. Nếu PowerShell làm hỏng dấu nháy, dùng extension mssql thay cho `sqlcmd`.]

Truy vấn theo thứ tự luồng (tên bảng/cột lấy từ `002-topups.ts`, `001-ledger.ts:31-34`, `db/payment/001-init.ts`; tenant `acme` ví dụ):
```sql
-- DB billing_wallet
SELECT id, customer_id, status, charge_id, failure_code, attempts, next_attempt_at, created_at, completed_at
FROM t_acme.topups WHERE id = 'tp_xxxxx';
SELECT * FROM t_acme.idempotency_keys WHERE topup_id = 'tp_xxxxx';
SELECT * FROM t_acme.ledger_transactions WHERE business_key = 'topup:tp_xxxxx';   -- chỉ có khi đã SUCCEEDED

-- DB billing_payment
SELECT * FROM charges WHERE reference = 'tp_xxxxx';
SELECT * FROM webhook_events WHERE charge_id = '<chargeId từ dòng trên>';
SELECT * FROM webhook_attempts WHERE event_id = '<event_id từ dòng trên>';
```
Trạng thái đã kiểm chứng trong schema: `topups.status` ∈ `REQUESTED, PENDING, SUCCEEDED, FAILED`; `charges.status` ∈ `PENDING, SUCCEEDED, FAILED`; `webhook_events.status` ∈ `PENDING, DELIVERED, FAILED` (check constraint trong migration). `webhook_attempts` ghi từng lần gửi webhook (`deliver-due-webhooks.ts:70-76`).
Hai DB dùng hai tài khoản khác nhau (`billing_wallet_app`, `billing_payment_app`); với truy vấn tạm thời có thể dùng `sa`.

---

## 6. Bài tập truy vết (không sửa code)

**Bài 1: theo dõi một lần nạp thành công.**
Thực hiện 5.2 và 5.3; ghi `topupId`. Sau khi webhook về, dựng bảng 6 dòng: thời điểm, hệ thống, sự kiện, khóa dùng để nhận ra (xem 5.4). Dùng SQL ở 5.6 để điền cột trạng thái. Kết quả mong đợi: `topups.status = SUCCEEDED`, có một dòng `ledger_transactions` với `business_key = topup:<topupId>`, `charges.status = SUCCEEDED`, `webhook_events.status = DELIVERED`.

**Bài 2: payment chết, wallet gửi lại bằng Worker (đường không có correlation id).**
1. Chế độ A: dừng cấu hình payment trong debugger (hoặc Chế độ B: `docker compose ... stop payment`). Gửi `POST /topups` mới (idempotency key mới).
2. Client vẫn nhận `202`. Chạy SQL (5.6). Theo `Topup.recordUnavailable` (`topup.ts:102-117`): `status` **giữ nguyên `REQUESTED`**, `attempts` tăng 1, `next_attempt_at = now + backoff[attempts-1]` (backoff mặc định `1,5,30,120,600` giây: `TOPUP_SUBMIT_BACKOFF`, `.env.example`).
3. Log của wallet có dòng `payment unavailable; topup retry scheduled` (`submit-topup.ts:128`) kèm `topupId`, `attempt`, `error`. **Dòng này không có `correlationId`** nếu do Worker ghi (lab C).
4. Bật payment lại; đến hạn `next_attempt_at` (điều kiện `Topup.isDue`: `status = REQUESTED` và `next_attempt_at <= now`, `topup.ts:64-70`), `Worker` (`bootstrap.ts:259-264`) gọi `SubmitDueTopups` → `SubmitTopup.executeNextDue` (`submit-topup.ts:55`). Đặt breakpoint ở `submit-topup.ts:68`: `Call Stack` bắt đầu từ `Worker.tick`, không từ HTTP.
5. Khi payment trả `202`, `recordSubmitted` (`topup.ts:78-87`) đặt `status = PENDING`, ghi `charge_id`, `next_attempt_at = NULL`. Webhook sau đó chuyển sang `SUCCEEDED`.
6. Nhánh hết lượt: nếu payment chết lâu hơn số bậc backoff (5 bậc mặc định), lần thất bại tiếp theo đặt `FAILED` với `failure_code = PAYMENT_UNAVAILABLE`. Webhook thành công đến muộn **vẫn được chấp nhận** cho trường hợp này (`topup.ts:119-125`, "cổng thanh toán là nguồn sự thật"). Bạn thử lại bằng cách để payment tắt đủ lâu, hoặc đặt `TOPUP_SUBMIT_BACKOFF=1,1` trong `wallet.debug.env` để rút ngắn. [CHƯA CHẠY]

**Bài 3: bắt cùng một topup đi qua cả hai dịch vụ chỉ bằng conditional breakpoint.**
Đặt ba conditional breakpoint (5.5) với cùng `topupId` tại `submit-topup.ts:68`, `create-charge.ts:57`, `webhooks.controller.ts:69`. Chạy hai request nạp song song (hai customer khác nhau) và xác nhận debugger chỉ dừng cho đúng topup bạn chọn.

**Bài 4 (đọc code, không chạy):** trả lời bằng `file:dòng` — vì sao webhook payment → wallet không thể mang correlation id nếu không đổi dữ liệu lưu trữ? (gợi ý: `deliver-due-webhooks.ts:52-61` lấy sự kiện từ DB trong `Worker`, không thuộc request nào.)

---

## 7. Xử lý sự cố khi setup

| Triệu chứng | Nguyên nhân thường gặp / cách xử lý |
| ----------- | ----------------------------------- |
| Service thoát ngay, log `invalid configuration, refusing to start` + `problems: [...]` | Thiếu biến trong `*.debug.env` hoặc chưa đặt `envFile` (`wallet/src/main.ts:16`). Đọc mảng `problems`, đối chiếu `.env.example`. |
| `ECONNREFUSED 127.0.0.1:11433` | Chưa `up` hạ tầng, hoặc `LOCAL_SQL_PORT` khác 11433. `docker compose ... ps -a`. |
| `Login failed for user 'billing_wallet_app'` | Mật khẩu trong `*.debug.env` khác `deploy/.env`, hoặc `billing-sql-init` chưa `Exited (0)`. |
| Wallet báo thiếu migration/tenant khi khởi động | `assertMigrated` (`bootstrap.ts:91`): chạy lại job `migrate` (`docker compose ... up migrate`). |
| Lỗi kết nối broker khi khởi động | `billing-rabbitmq-init` chưa chạy xong (exchange chưa tạo; kiểm tra passive trả 404, `topology.ts:33-35`). |
| Cổng 3001/3002 đã dùng | Container wallet/payment đang chạy: `docker compose ... stop wallet payment`. |
| Message đơn hàng "biến mất" khi debug local | Wallet trong Docker cùng consume hàng đợi `wallet.order-payments`; dừng nó. |
| Breakpoint xám (local) | Đang chạy file khác; kiểm tra `program`/`cwd`; thêm `"sourceMaps": true`. |
| Breakpoint xám (Docker) | Sai `remoteRoot`/`localRoot`; sửa code mà chưa `restart`. |
| Build image rất chậm lần đầu | Bình thường (`pnpm install` trong `Dockerfile.dev`); xem `local-stack.vi.md`. |
| Shell script trong `deploy/scripts` lỗi `\r` | Có thể do chuyển dòng CRLF khi clone trên Windows; `.editorconfig` quy định `lf`. [GIẢ THUYẾT, chưa gặp] |

---

## 8. Kiểm tra cuối bài

1. Header nào wallet gửi sang payment ở `POST /charges` hiện tại, và vì sao `x-correlation-id` ở payment lại khác id của khách?
2. Vì sao breakpoint ở `inline-topup-submitter.ts:16` dừng trước khi client nhận `202`?
3. Hai khóa nào nối một lần nạp giữa wallet và payment (vì correlation id không được truyền sang payment)? Truy vấn SQL nào xác nhận điều đó ở phía payment?
4. Vì sao đường Worker không có `correlationId` trong log?
5. Vì sao phải dừng container wallet/payment khi debug local?
6. `envFile` giải quyết vấn đề gì mà cấu hình `Debug wallet-service` có sẵn không giải quyết được?
7. Vì sao cổng 9229 chỉ được publish ra `127.0.0.1`?

### Đáp án
1. `content-type`, `idempotency-key` (`http-payment-gateway.ts:24-27`); payment không nhận header nên `resolveCorrelationId` sinh UUID mới (`correlation.ts:17-19`, `app.ts:30`).
2. `submitSoon` gọi async IIFE, phần đồng bộ của nó chạy ngay đến `await` đầu tiên (lab Ngày 2 `topup-async-flow.ts`), trước khi `execute` trả về.
3. `topupId` (= `reference` bên payment) và idempotency key `topup:<tenant>:<topupId>` (`submit-topup.ts:69-71`). Truy vấn: `SELECT * FROM charges WHERE reference = '<topupId>'` trong DB `billing_payment`.
4. Worker chạy từ `setTimeout`, không thuộc request nào nên `AsyncLocalStorage` rỗng (lab C `tp_worker`).
5. Trùng cổng; hai wallet cùng consume một hàng đợi nên message bị chia.
6. `tsx` không đọc `.env`; service chỉ đọc `process.env` và sẽ từ chối khởi động nếu thiếu biến.
7. Inspector cho phép chạy mã tùy ý; không được lộ ra mạng ngoài.

---

## 9. Câu hỏi còn mở (cho đội dev)

1. Việc wallet không gửi `x-correlation-id` sang payment và payment không gửi lại trong webhook là chủ ý thiết kế? (Quyết định hiện tại của bạn: không đổi code; hướng dẫn này dựa trên hành vi hiện có.)
2. Với đường Worker và webhook, đội dev có kế hoạch lưu correlation id trong DB không?
3. `compose.local.yml` + `-f compose.debug.yml`: kết quả bước `config` trên máy của bạn là gì?
4. Ở Bài 2, `attempts` và `next_attempt_at` thực tế bạn quan sát có khớp `topup.ts:102-117` không?
