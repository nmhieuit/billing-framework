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

**Hệ quả cho hướng dẫn này:**
- Phần 3–5 dạy bạn debug luồng **như code hiện tại đang chạy** và dùng đúng những khóa liên kết có thật (`topupId`, idempotency key, `x-webhook-event-id`) để nối wallet với payment.
- Phần 6 là bài tập sửa code: **thêm `x-correlation-id` vào request wallet → payment** (bản vá 3 dòng đã chạy thử).
- **Cần bạn xác nhận** (xem Phần 9): đây là chủ ý thiết kế hay chỗ còn thiếu? Tôi chưa áp dụng bản vá vào code của repo.

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
Cấu hình `Attach to process (9229)` đã có chỉ gắn cổng, nhưng thiếu ánh xạ đường dẫn container ↔ máy. Thêm:
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
`remoteRoot: /app` khớp bind mount `../services/wallet/src:/app/services/wallet/src` (`compose.services.yml` `x-sources`). Thêm compound `"Attach wallet + payment (Docker)"` tương tự mục 3.3. [CHƯA CHẠY]

### 4.4. Gắn debugger
1. Đảm bảo log container có dòng `Debugger listening on ws://0.0.0.0:9229/...`: `docker compose ... logs wallet | Select-String "Debugger"`.
2. F5 với **Attach wallet (Docker)**; thanh debug hiện, breakpoint chuyển từ xám sang đỏ.
3. Nếu breakpoint giữ màu xám: kiểm tra `remoteRoot`/`localRoot`, hoặc mở Debug Console xem thông báo. Chụp màn hình lỗi gửi lại.

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
5. **#5 → #6**: F5 đến `http-payment-gateway.ts:22`. Xem biến `headers` (đối tượng literal ở dòng 24–27): chỉ có hai khóa `content-type`, `idempotency-key`. Chưa có `x-correlation-id`. (Lab C đã chứng minh `getCorrelationId()` ở đây vẫn trả id của khách; hàm này chưa được import trong file nên Debug Console sẽ báo `not defined` trước khi vá. Sau khi áp dụng bản vá ở Phần 6, bạn thêm được Watch `correlationId`.)
6. **#7** (payment `app.ts:30`): `request.headers['x-correlation-id']` là `undefined`; sau `resolveCorrelationId` biến `correlationId` là UUID **mới** — khác id của khách.
7. **#8** (`create-charge.ts:57`): `input.reference` = `topupId` ở wallet; `input.idempotencyKey` = `topup:acme:<topupId>` (`submit-topup.ts:69`). **Đây là khóa nối hai hệ thống hiện nay.**
8. Quay lại **#11**: sau khi payment trả `202 {chargeId}`, `topups.save(current.recordSubmitted(...))`. Gọi `GET /topups/<topupId>` để xem trạng thái (xem trường `status`).
9. Chờ worker payment (chu kỳ `WORKER_INTERVAL_MS`, mặc định 500ms trong compose): **#9** dừng ở `deliver-due-webhooks.ts:61`, rồi **#10** dừng ở `webhooks.controller.ts:69` trên wallet. Ở request webhook này, `correlation.middleware.ts` sinh một id **khác nữa** (payment không gửi header).
10. Kết quả cuối: `GET /topups/<topupId>` → trạng thái chốt (ví dụ `SUCCEEDED`), `GET /wallet/entries` có dòng sổ cái (`ledger-transaction.ts:73`, khóa `topup:<topupId>`). Chi tiết trạng thái: [GIẢ THUYẾT: bạn quan sát và ghi lại tên trạng thái thực tế].

### 5.4. Truy vết khi KHÔNG có correlation id xuyên suốt (hiện tại)
Dùng chuỗi khóa có thật:
| Hệ thống | Khóa tìm trong log / DB |
| -------- | ----------------------- |
| Wallet HTTP | `correlationId` = id khách gửi |
| Wallet → payment | `topupId`; idempotency key `topup:<tenant>:<topupId>` |
| Payment | `reference` (= topupId), `chargeId` |
| Payment → wallet | `x-webhook-event-id`, `payload.data.reference` (= topupId) |
Log `SubmitTopup` chỉ ghi khi lỗi hoặc retry (`submit-topup.ts:116-132`): thành công thì **không có dòng log**, hãy dùng debugger/DB để xác nhận.

---

## 6. Bài tập sửa code: truyền correlation id sang payment (đã chạy thử, đã hoàn tác)

Sửa `services/wallet/src/infrastructure/http-payment-gateway.ts` (tạo nhánh học: `git switch -c hoc/ngay-3-correlation`):
```diff
+import { CORRELATION_HEADER, getCorrelationId } from '@billing/observability';
 import type {
   GatewayChargeRequest,
@@
   async createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult> {
     const doFetch = this.options.fetchImpl ?? fetch;
+    const correlationId = getCorrelationId();
     try {
@@
         headers: {
           'content-type': 'application/json',
           'idempotency-key': request.idempotencyKey,
+          ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
         },
```
Kết quả đã kiểm chứng [ĐÃ CHẠY]:
- Lab A in `content-type, idempotency-key, x-correlation-id` và `CÓ (= <id>)`.
- `corepack pnpm vitest run services/wallet/src/infrastructure/http-payment-gateway.test.ts`: 13 test pass.
- `typecheck`, `eslint`, `prettier --check` trên file này: không lỗi.
- Quy tắc ranh giới (`infrastructure` được phép import package dùng chung; `FRAMEWORKS` không chứa `@billing/observability`, `eslint.config.js:6-17`).

Sau khi vá, chạy lại luồng ở Phần 5: breakpoint #7 (`app.ts:30`) thấy `request.headers['x-correlation-id']` = id của khách; log của payment và response header cùng id. Hai điều **vẫn chưa** được giải quyết bởi bản vá này:
1. **Đường Worker** (gửi lại khi lần gửi ngay thất bại): không có ngữ cảnh request nên không có id (lab C). Muốn có phải lưu correlation id cùng bản ghi topup. **Cần thay đổi schema/migration; ngoài phạm vi bài tập.**
2. **Webhook payment → wallet**: worker payment chạy ngoài request nên cũng cần lưu id cùng webhook event. **Chưa khảo sát chi tiết.**

Bài tập thêm: viết test trong `http-payment-gateway.test.ts` khẳng định header có mặt khi chạy trong `runWithCorrelation(...)` và vắng mặt khi chạy ngoài. Đọc test hiện có để biết cách giả `fetchImpl`.

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
3. Hai khóa nào dùng để nối một lần nạp giữa wallet và payment khi chưa có correlation id xuyên suốt?
4. Vì sao đường Worker không có `correlationId` trong log?
5. Vì sao phải dừng container wallet/payment khi debug local?
6. `envFile` giải quyết vấn đề gì mà cấu hình `Debug wallet-service` có sẵn không giải quyết được?
7. Vì sao cổng 9229 chỉ được publish ra `127.0.0.1`?

### Đáp án
1. `content-type`, `idempotency-key` (`http-payment-gateway.ts:24-27`); payment không nhận header nên `resolveCorrelationId` sinh UUID mới (`correlation.ts:17-19`, `app.ts:30`).
2. `submitSoon` gọi async IIFE, phần đồng bộ của nó chạy ngay đến `await` đầu tiên (lab Ngày 2 `topup-async-flow.ts`), trước khi `execute` trả về.
3. `topupId` (= `reference` bên payment) và idempotency key `topup:<tenant>:<topupId>` (`submit-topup.ts:69-71`).
4. Worker chạy từ `setTimeout`, không thuộc request nào nên `AsyncLocalStorage` rỗng (lab C `tp_worker`).
5. Trùng cổng; hai wallet cùng consume một hàng đợi nên message bị chia.
6. `tsx` không đọc `.env`; service chỉ đọc `process.env` và sẽ từ chối khởi động nếu thiếu biến.
7. Inspector cho phép chạy mã tùy ý; không được lộ ra mạng ngoài.

---

## 9. Câu hỏi còn mở (cho bạn và đội dev)

1. **Cần bạn xác nhận:** wallet không gửi correlation id sang payment là chủ ý hay chỗ còn thiếu? Nếu là chỗ thiếu, bạn có muốn áp dụng bản vá ở Phần 6 vào repo không? (Tôi chưa áp dụng.)
2. Với đường Worker và webhook, đội dev có kế hoạch lưu correlation id trong DB không?
3. `compose.local.yml` + `-f compose.debug.yml`: kết quả bước `config` trên máy của bạn là gì?
4. Tên trạng thái thực tế của topup trong quá trình chạy (bạn quan sát được những giá trị nào)?
