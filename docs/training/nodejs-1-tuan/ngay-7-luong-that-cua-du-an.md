# Ngày 7: Hai luồng thật của dự án `billing-framework`

> Thời lượng: 4 giờ (cộng phần Docker tùy chọn). Sáu ngày qua bạn tự dựng các mảnh nhỏ. Hôm nay bạn dùng chúng để **đọc, chạy, debug và viết thêm test** cho hai luồng thật của wallet: `GET /wallet` (đọc) và `POST /topups` (ghi + chạy nền sang payment). Mọi dòng được trích dẫn dạng `file:dòng` đều đã được mở đọc từ code hiện tại; **khi docs và code khác nhau, code là đúng**.

## Mục tiêu

- Chạy các test của dự án mà không cần Docker, và biết test nào cần Docker.
- Đọc một luồng bằng phương pháp: điểm vào → từng hàm được gọi → ghi lại `file:dòng` và dữ liệu đi qua.
- Kể lại được luồng `GET /wallet` và luồng `POST /topups` đúng thứ tự hàm, kèm `file:dòng`.
- Nhận ra các mảnh bạn đã tự viết ở Ngày 5-6 trong code thật, và nêu được những điểm code thật làm **kỹ hơn**.
- Đặt breakpoint trong code thật và quan sát việc chạy nền.
- Viết thêm hai file test cho code thật (và kiểm tra test của mình có "bắt" được lỗi).

## Quy tắc an toàn cho ngày hôm nay

Hôm nay bạn làm việc **trong repo thật**, nên:

1. Tạo nhánh học riêng: `git switch -c hoc/ngay-7`. Mọi file bạn thêm hôm nay nằm trên nhánh này.
2. **Không sửa** file trong `services/` hay `packages/`, trừ khi một bài ghi rõ là "thử phá" (để kiểm tra test), và luôn hoàn tác ngay bằng `git checkout <file>` hoặc `git restore <file>`.
3. Các file test bạn thêm là file **mới** (đuôi `.day7.test.ts`). Cuối ngày xóa chúng, `git status` phải sạch.
4. Không `git push` nhánh học.

## Chuẩn bị (15 phút)

Từ đây dùng terminal ở **thư mục gốc repo** (không phải `node-training`).

| Bước | Lệnh | Mong đợi |
| ---- | ---- | -------- |
| 1 | `git switch -c hoc/ngay-7` | `Switched to a new branch 'hoc/ngay-7'` |
| 2 | `corepack pnpm install` | Cài các gói của cả monorepo (lần đầu có thể vài phút) |
| 3 | Mở thư mục gốc repo bằng VS Code (`code .`) | VS Code dùng `.vscode/launch.json` của dự án |

Nếu gõ `pnpm` được thì không cần `corepack` đứng trước (dự án dùng `corepack pnpm ...` trong tài liệu để chắc chắn).

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | Cách đọc code có phương pháp, chạy test dự án | 30 phút |
| 2 | Luồng `GET /wallet` + Bài 1, 2 | 55 phút |
| 3 | Luồng `POST /topups` + Bài 3, 4 | 80 phút |
| 4 | Viết test cho code thật: Bài 5, 6 | 55 phút |
| 5 | Kể lại luồng và tổng kết tuần | 20 phút |
| (6) | Tùy chọn: chạy cả hệ thống bằng Docker | ngoài 4 giờ |

---

## Khối 1: Cách đọc code, và chạy test của dự án (30 phút)

### Bản đồ nhanh của repo

| Thư mục | Là gì |
| ------- | ----- |
| `services/wallet/` | Dịch vụ ví: tạo ví, nạp tiền, sổ cái, đối soát (NestJS chạy trên Fastify) |
| `services/payment/` | Dịch vụ thanh toán giả lập cổng thanh toán (Fastify) |
| `packages/` | Thư viện dùng chung: tiền (`@billing/money`), database, runtime, test... |
| `deploy/` | Docker Compose: SQL Server, RabbitMQ, wallet, payment... |

Trong `services/wallet/src/`, code chia theo **bốn lớp** (khác bản ba lớp bạn dựng ở Ngày 5, nhưng cùng ý tưởng):

| Thư mục | Vai trò | Tương ứng Ngày 5 |
| ------- | ------- | ---------------- |
| `interface/http/` | Nhận request, đọc header / body, đổi lỗi thành mã HTTP | lớp HTTP |
| `application/` | Từng "ca sử dụng" (`GetWallet`, `RequestTopup`...) điều phối các bước | service |
| `domain/` | Quy tắc thuần túy: `Account`, `Topup`... không biết HTTP hay database | phần quy tắc của service |
| `infrastructure/` | Nói chuyện với thế giới ngoài: database (Kysely), gọi payment (`fetch`)... | repository |

Quy tắc phụ thuộc: các lớp bên trong không import các lớp bên ngoài (domain không import infrastructure...).

### Sáu bước đọc một luồng

1. **Tìm điểm vào**: route nào (`@Get('wallet')`).
2. **Đi theo từng lời gọi hàm**, mở từng file, ghi `file:dòng` vào sổ tay.
3. Ở mỗi hàm ghi: **nhận gì, trả gì, ném lỗi gì**.
4. Chú ý **ranh giới bất đồng bộ**: chỗ `await`, chỗ chạy nền (`.catch`, không `await`).
5. Chú ý **ranh giới giao dịch cơ sở dữ liệu**: cái gì nằm trong cùng `uow.run(...)`.
6. Cuối cùng tìm **test** của đoạn code đó: test cho bạn biết hành vi mong đợi bằng ví dụ.

### Chạy test của dự án (không cần Docker)

Dự án có hai loại test:

| Loại | Tên file | Cần Docker? |
| ---- | -------- | ----------- |
| Test đơn vị | `*.test.ts` | Không |
| Test tích hợp | `*.integration.test.ts` | **Có** (SQL Server / RabbitMQ thật) |

Lệnh `corepack pnpm test` của dự án chỉ chạy loại đầu. Thử chạy 5 file test đơn vị liên quan đến hôm nay:

```text
$ corepack pnpm vitest run services/wallet/src/domain/topup.test.ts services/wallet/src/application/inline-topup-submitter.test.ts services/wallet/src/infrastructure/http-payment-gateway.test.ts services/wallet/src/infrastructure/tenant-registry.test.ts services/wallet/src/domain/account.test.ts
 RUN  v5.0.3 C:/billing-framework


 Test Files  5 passed (5)
      Tests  59 passed (59)
```

Toàn bộ test đơn vị của dự án: `corepack pnpm test` (hơn 1000 test, vài chục giây trên máy biên soạn). Các lệnh kiểm tra chất lượng khác: `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm format:check`.

---

## Khối 2: Luồng `GET /wallet` (30 phút đọc + Bài 1, 2)

`GET /wallet` trả về ví của khách đang gọi: số dư, loại tiền, thời điểm tạo. Chỉ **đọc**, không ghi, không bất đồng bộ nền: luồng đơn giản nhất để tập đọc.

Gateway đặt hai header: `x-tenant-id` (khách thuộc "tenant" nào, một tenant là một khách hàng doanh nghiệp, mỗi tenant có schema dữ liệu riêng) và `x-customer-id` (khách nào).

### Các bước (đã mở đọc từng file)

| # | File:dòng | Chuyện gì xảy ra |
| - | --------- | ---------------- |
| 1 | `services/wallet/src/interface/http/wallets.controller.ts:42-45` | `@Get('wallet')` bắt route. Hàm `get(@CurrentCaller() caller)` gọi `this.getWallet.execute({ tenant, customerId })` |
| 2 | `wallets.controller.ts:12` | `@UseGuards(CallerGuard)` ở mức `class`: **guard chạy trước** mọi route của controller này |
| 3 | `services/wallet/src/interface/http/caller.guard.ts:30-39` | `CallerGuard.canActivate`: dòng 32 đổi `x-tenant-id` thành `TenantId` hợp lệ; dòng 33-36 thiếu `x-customer-id` thì ném `MissingCustomerError`; dòng 37 gắn `request.caller` |
| 4 | `services/wallet/src/infrastructure/tenant-registry.ts:13-27` | `resolve(raw)`: rỗng → `MissingTenantError` (dòng 15); không hợp lệ hoặc không có trong cấu hình → `UnknownTenantError` (dòng 21, 25) |
| 5 | `wallets.controller.ts:16` và `services/wallet/src/bootstrap.ts:190` | Controller nhận `GetWallet` qua `@Inject(GET_WALLET)`; ở `bootstrap.ts:190` object thật được tạo bằng `new GetWallet({ uow })` |
| 6 | `services/wallet/src/application/get-wallet.ts:11-17` | `execute`: chạy `uow.run(tenant, ...)` (dòng 12), gọi `accounts.find(Account.walletId(customerId))` (dòng 13); không có ví thì ném `WalletNotFoundError` (dòng 15); có thì `toWalletView(wallet)` (dòng 16) |
| 7 | `services/wallet/src/domain/account.ts:27-29` | `Account.walletId(customerId)` = chuỗi `wallet:<customerId>` |
| 8 | `services/wallet/src/infrastructure/kysely/unit-of-work.ts:22-40` | `run`: mở **một giao dịch SQL** (dòng 24), gắn schema của tenant (`trx.withSchema(schema)`, dòng 25), tạo các repository (dòng 26-38) |
| 9 | `services/wallet/src/infrastructure/kysely/account.repository.ts:16-23` | `find(id)`: `selectFrom('accounts') ... where('id', '=', id)`; không có hàng thì `null` |
| 10 | `services/wallet/src/application/views.ts:12-20` | `toWalletView`: đổi `Account` thành `{ customerId, currency, balance, createdAt }` |
| 11 | `services/wallet/src/interface/http/errors.ts:67-79` | Bảng ánh xạ lỗi → HTTP: `MissingTenantError` → 400 `MISSING_TENANT`, `UnknownTenantError` → 403, `MissingCustomerError` → 400 `MISSING_CUSTOMER`, `WalletNotFoundError` → 404 `WALLET_NOT_FOUND` |

Đối chiếu Ngày 5: bước 1 = lớp HTTP; bước 6 = service; bước 9 = repository; bảng ở bước 11 = đoạn `try/catch` + `instanceof` bạn đã tự viết, nhưng gom về một chỗ. Bước 8 mới: ngày 5 bạn lưu trong `Map`, dự án thật lưu trong SQL Server qua **Kysely** (thư viện viết truy vấn SQL bằng TypeScript), và mỗi `uow.run` là **một giao dịch**.

Sơ đồ tuần tự của luồng này (vẽ bằng draw.io) nằm ở `docs/training/nodejs-1-tuan/diagrams/runtime-request-sequence.drawio`. Ghi chú: một số chú thích trong file đó nhắc đến các bài lab của giáo trình cũ đã bị xóa khỏi repo; nội dung các lab vẫn xem lại được trong lịch sử git.

### Bài 1: Lần theo `GET /wallet` (Cơ bản, 25 phút)

Không nhìn bảng trên. Mở `wallets.controller.ts` rồi tự lần theo, ghi vào sổ tay 8 mục: file, dòng, hàm, làm gì. Sau đó so với bảng. Đạt khi bạn tìm đúng cả 8 chặng chính (controller, guard, tenant registry, use case, unit of work, repository, view, bảng ánh xạ lỗi) mà không cần xem bảng.

### Bài 2: Mã lỗi (Trung bình, 15 phút)

Trả lời **từ code** (ghi `file:dòng`), rồi xem đáp án:

1. Gọi `GET /wallet` thiếu header `x-tenant-id`, kết quả HTTP gì?
2. Có `x-tenant-id: zzz` (không có trong cấu hình)?
3. Có tenant hợp lệ nhưng thiếu `x-customer-id`?
4. Có đủ header nhưng khách chưa tạo ví?
5. Thiếu cả hai header, lỗi nào xảy ra trước, vì sao?

<details><summary>Đáp án</summary>

1. `400 MISSING_TENANT`: `caller.guard.ts:32` gọi `registry.resolve(undefined)`, `tenant-registry.ts:14-15` ném `MissingTenantError`; `errors.ts:67` ánh xạ sang 400.
2. `403 UNKNOWN_TENANT`: `tenant-registry.ts:24-25` không tìm thấy; `errors.ts:68`.
3. `400 MISSING_CUSTOMER`: `caller.guard.ts:33-36`; `errors.ts:69`.
4. `404 WALLET_NOT_FOUND`: `get-wallet.ts:15`; `errors.ts:79`.
5. `MISSING_TENANT` trước: dòng 32 (tenant) chạy trước dòng 33 (customer) trong `canActivate`.

</details>

---

## Khối 3: Luồng `POST /topups` (45 phút đọc + Bài 3, 4)

Đây là luồng "có tất cả" mà Ngày 5-6 đã chuẩn bị: kiểm tra đầu vào, `Idempotency-Key`, giao dịch cơ sở dữ liệu, **trả `202` rồi chạy nền sang payment**, thử lại theo bậc.

### Bản đồ ba chặng

```text
CHẶNG 1 (trong request)            CHẶNG 2 (chạy nền, ngay sau request)        CHẶNG 3 (sau đó)
POST /topups                       InlineTopupSubmitter.submitSoon             payment gọi lại wallet (webhook)
 └ RequestTopup.execute             └ SubmitTopup.executeFor                    └ ApplyPaymentResult
    - lưu topup REQUESTED              - claim (đặt lease)                         - ghi nhận kết quả cuối
    - lưu khóa idempotency             - gọi payment (HttpPaymentGateway)         - cộng tiền vào ví + ghi sổ cái
    - trả 202                          - ghi kết quả: PENDING / retry / FAILED
```

### Chặng 1: trong request

| # | File:dòng | Chuyện gì xảy ra |
| - | --------- | ---------------- |
| 1 | `services/wallet/src/interface/http/topups.controller.ts:42-44` | `@Post('topups')` với `@HttpCode(202)`: luôn trả `202` khi thành công |
| 2 | `topups.controller.ts:20-32` và dòng 49 | `readIdempotencyKey`: thiếu header → 400 `MISSING_IDEMPOTENCY_KEY`; dài quá 255 ký tự hoặc có khoảng trắng đầu / cuối → 400 `INVALID_IDEMPOTENCY_KEY` |
| 3 | `topups.controller.ts:50-56` | Body phải là đối tượng JSON và `amount` phải là `number`, nếu không → 400 `INVALID_REQUEST` |
| 4 | `topups.controller.ts:57-63` | Gọi `requestTopup.execute(...)` và trả `result.body` |
| 5 | `services/wallet/src/application/request-topup.ts:42-44` | `execute` bọc việc chính trong **một** `uow.run(...)` (một giao dịch SQL) |
| 6 | `request-topup.ts:45-46` | Tìm ví của khách; không có → `WalletNotFoundError` (404) |
| 7 | `request-topup.ts:48-51` | `Money.of(amount, currency)` (tiền là số nguyên, kiểm tra hợp lệ) và `requestHash` = SHA-256 của `{ amount, currency }`: **fingerprint** của Ngày 5 |
| 8 | `request-topup.ts:53-54` | `idempotency.find(customerId, key)`: đã có khóa thì `replay(...)` |
| 9 | `request-topup.ts:92-103` | `replay`: `requestHash` khác → `IdempotencyConflictError` (HTTP 422 `IDEMPOTENCY_KEY_REUSED`, `interface/http/errors.ts:86-90`); giống → trả lại body đã lưu, `replayed: true` |
| 10 | `request-topup.ts:56-65` | Khóa mới: `Topup.request(...)` tạo lệnh `REQUESTED` (`domain/topup.ts:32-58`), rồi `topups.insert(topup)` |
| 11 | `request-topup.ts:66-74` | `idempotency.save(...)` lưu khóa cùng response trong **cùng giao dịch** với bước 10: hoặc có cả hai, hoặc không có gì |
| 12 | `request-topup.ts:78-86` | Nếu `DuplicateKeyError` (hai request cùng khóa đến đồng thời, request thua vấp khóa chính, giao dịch hoàn tác): **chạy lại đúng một lần**, lần này sẽ thấy bản ghi của request thắng và phát lại. Đây là cách giải bài toán race condition của Ngày 5, nhưng bằng ràng buộc của database |
| 13 | `request-topup.ts:87-88` | **Sau khi đã commit**, chỉ với lần tạo mới (`!result.replayed`): `submitter.submitSoon(tenant, topupId)`. Hàm này **không trả Promise**; chạy nền |

### Chặng 2: chạy nền sang payment

| # | File:dòng | Chuyện gì xảy ra |
| - | --------- | ---------------- |
| 14 | `services/wallet/src/application/inline-topup-submitter.ts:14-17` | `submitSoon`: tạo `attempt`, một hàm `async` tự gọi `await this.deps.submit.executeFor(tenant, topupId)` |
| 15 | `inline-topup-submitter.ts:18-27` | `.catch`: lỗi được **ghi log** (`log.error(..., 'inline topup submission failed; the worker will retry')`), kể cả khi chính logger hỏng (`try/catch` lồng ở dòng 19-26) |
| 16 | `inline-topup-submitter.ts:28-31` | `.finally` xóa `attempt` khỏi `#pending`; dòng 31 thêm `attempt` vào `#pending` |
| 17 | `inline-topup-submitter.ts:34-36` | `drain()`: chờ mọi `#pending` xong, dùng khi tắt dịch vụ |
| 18 | `services/wallet/src/application/submit-topup.ts:42-52` | `executeFor`: **giao dịch ngắn đầu tiên**: khóa lệnh (`lockById`), kiểm tra `isDue(now)` (`domain/topup.ts:64-70`), rồi `claim(now, 60s)` (dòng 48) và lưu |
| 19 | `domain/topup.ts:72-76` | `claim`: đẩy `nextAttemptAt` ra sau `leaseSeconds` (mặc định 60 giây, `submit-topup.ts:16`) **mà chưa tính là một lần thử**. Nhờ vậy nếu process chết giữa chừng, lệnh vẫn còn `REQUESTED` và tự đến hạn sau 60 giây để worker thử lại |
| 20 | `submit-topup.ts:66-73` | `submitClaimed`: gọi `gateway.createCharge(...)` **NGOÀI giao dịch**, với `idempotencyKey: \`topup:<tenant>:<topupId>\`` cố định: gọi lại luôn an toàn |
| 21 | `services/wallet/src/infrastructure/http-payment-gateway.ts:19-35` | `createCharge`: `fetch` có `signal: AbortSignal.timeout(timeoutMs)` (dòng 34), giống `ex02` Ngày 6 |
| 22 | `http-payment-gateway.ts:44-48, 49-60, 61-64` | `202` + có `chargeId` → `created`; `4xx` (trừ 408, 429) → `rejected`; còn lại và mọi lỗi mạng → `unavailable` (không bao giờ ném lỗi) |
| 23 | `submit-topup.ts:76-80` | **Giao dịch thứ hai** ghi kết quả. Nếu lệnh không còn `REQUESTED` (webhook đã chốt trong lúc chờ payment) → `SUPERSEDED`, không ghi đè |
| 24 | `submit-topup.ts:81-96` | `created` → `recordSubmitted` (PENDING); `rejected` → `recordRejected` (FAILED, `PAYMENT_REJECTED`); `unavailable` → `recordUnavailable` |
| 25 | `domain/topup.ts:101-117` | `recordUnavailable`: `attempts + 1`; còn bậc chờ thì `nextAttemptAt = now + backoff[attempts - 1]` giây; hết bậc thì FAILED (`PAYMENT_UNAVAILABLE`). Chính là hàm `applyOutcome` của Bài 5 Ngày 6 |
| 26 | `services/wallet/src/config.ts:41` | Bậc chờ mặc định: `'1,5,30,120,600'` giây |

### Chặng 3: kết quả cuối đến sau (webhook)

| # | File:dòng | Chuyện gì xảy ra |
| - | --------- | ---------------- |
| 27 | `services/wallet/src/interface/http/webhooks.controller.ts:32` | `POST webhooks/payment` nhận sự kiện từ payment |
| 28 | `services/wallet/src/application/apply-payment-result.ts:99-100` | Trong một giao dịch: `inbox.record(CONSUMER, eventId, now)` ghi `eventId` vào "hộp thư đến"; webhook **trùng** vấp khóa chính → xử lý ở dòng 66-77, trả `DUPLICATE` |
| 29 | `apply-payment-result.ts:102-110` | Tìm lệnh theo `reference`; không có → `UNKNOWN_TOPUP`; số tiền / loại tiền / `chargeId` không khớp → `MISMATCH` |
| 30 | `domain/topup.ts:119-134` | `applySucceeded`: cho phép từ `REQUESTED`, `PENDING`, **và** từ `FAILED` với `PAYMENT_UNAVAILABLE` (dòng 122, "thành công đến muộn": payment là nguồn sự thật) |
| 31 | `apply-payment-result.ts:115-135` | Thành công: khóa hai tài khoản (ví và tài khoản cổng thanh toán), cộng ví, trừ tài khoản cổng, ghi sổ cái (`ledger.post(...)`): ghi sổ kép như Bài 8 Ngày 5 |

Sơ đồ ba chặng này ở dạng draw.io (3 trang: luồng thành công; bị trùng; payment chậm và thử lại): `docs/training/nodejs-1-tuan/diagrams/topup-flows.drawio`.

### Nhận ra những mảnh bạn đã tự viết, và những điểm thật làm kỹ hơn

| Bạn đã viết | Trong code thật | Điểm khác |
| ----------- | --------------- | --------- |
| Ngày 5, Bài 6: endpoint nạp tiền có `Idempotency-Key` | `topups.controller.ts` + `request-topup.ts` | Khóa và lệnh lưu trong **cùng một giao dịch SQL**; hai request đồng thời được xử lý bằng ràng buộc của database và chạy lại một lần (`request-topup.ts:78-86`) |
| Ngày 6, Bài 2: `createCharge` | `http-payment-gateway.ts` | Mã `408` và `429` cũng coi là `unavailable` (thử lại được), không phải `rejected` (dòng 14, 49-53). Phản hồi `202` thiếu `chargeId` cũng là `unavailable` (dòng 47). Bài của bạn coi mọi `4xx` là `rejected` |
| Ngày 6, Bài 5: `applyOutcome` | `Topup.recordUnavailable` (`topup.ts:101-117`) | Tách thành các hàm riêng cho mỗi sự kiện, ném `StateTransitionError` nếu gọi sai trạng thái (`assertRequested`) |
| Ngày 6, Bài 6: gửi nền | `InlineTopupSubmitter` (`inline-topup-submitter.ts`) | Có `claim` với lease để process chết giữa chừng vẫn được thử lại, có worker định kỳ nhặt các lệnh đến hạn (`submit-topup.ts:55-64`, `executeNextDue`), và log lỗi cả khi logger hỏng |
| Ngày 6, Bài 7: webhook | `ApplyPaymentResult` (`apply-payment-result.ts`) | "Thành công đến muộn" chỉ được nhận khi lệnh `FAILED` **vì `PAYMENT_UNAVAILABLE`** (`topup.ts:122`), không phải mọi `FAILED`; kiểm tra khớp số tiền; ghi sổ cái |
| Ngày 3-6: `.catch` | `inline-topup-submitter.ts:18-27` | Cùng nguyên tắc: việc nền không bao giờ để lỗi rơi ra ngoài |

(Không có **circuit breaker** (ngắt mạch) trong code: chỉ có timeout và thử lại theo bậc, đúng như hai cơ chế bạn đã tự viết.)

### Bài 3: Lần theo `POST /topups` (Trung bình, 30 phút)

Không nhìn bảng ở trên. Với mỗi câu, ghi `file:dòng`:

1. `POST /topups` không có header `Idempotency-Key`: lỗi gì, ở dòng nào?
2. Hai request cùng `Idempotency-Key`, cùng `amount`: request thứ hai tạo thêm lệnh nạp không? Phần nào của code đảm bảo?
3. Cùng khóa nhưng `amount` khác: kết quả HTTP, và vì sao?
4. `submitSoon` có làm request chậm đi không? Vì sao?
5. Gọi payment nằm trong hay ngoài giao dịch cơ sở dữ liệu? Nếu nằm trong thì có hại gì?
6. Payment trả `503` ba lần liên tiếp với bậc chờ mặc định: trạng thái lệnh và `nextAttemptAt` sau lần thứ ba?
7. Payment chậm quá `timeoutMs`: `HttpPaymentGateway` trả gì?

<details><summary>Đáp án</summary>

1. `400 MISSING_IDEMPOTENCY_KEY`: `topups.controller.ts:21-23`, được gọi ở dòng 49.
2. Không. `request-topup.ts:53-54` thấy khóa đã có và gọi `replay` (dòng 92-103) trả body đã lưu với `replayed: true`; dòng 88 chỉ gọi `submitSoon` khi `!result.replayed`. Trong trường hợp đồng thời, `request-topup.ts:78-86`.
3. `422 IDEMPOTENCY_KEY_REUSED`: `request-topup.ts:93-96` ném `IdempotencyConflictError` khi `requestHash` khác; `interface/http/errors.ts:86-90`.
4. Không: `submitSoon` (`inline-topup-submitter.ts:14-32`) không trả Promise và không `await`; request đã `return` xong khi việc nền mới chạy. Lỗi nền được ghi log (dòng 18-27).
5. Ngoài (`submit-topup.ts:68`; giao dịch thứ nhất kết thúc ở dòng 50, giao dịch thứ hai bắt đầu ở dòng 76). Nếu nằm trong, giao dịch (và khóa dòng dữ liệu) sẽ bị giữ suốt thời gian chờ payment, chặn các request khác chạm cùng dữ liệu.
6. Lần 1: `attempts = 1`, `nextAttemptAt = now + 1s`; lần 2: `attempts = 2`, `+ 5s`; lần 3: `attempts = 3`, `+ 30s`. Vẫn `REQUESTED` (`topup.ts:105`, `116`; bậc ở `config.ts:41`). Lần thứ 6 mới thành `FAILED` (hết 5 bậc).
7. `{ kind: 'unavailable', error: ... }`: `AbortSignal.timeout` hủy `fetch` (dòng 34), lỗi rơi vào `catch` ở dòng 62-64.

</details>

### Bài 4: Debug việc chạy nền (Trung bình, 20 phút)

Dùng debugger trên **test đơn vị có sẵn** của dự án (không cần Docker): `services/wallet/src/application/inline-topup-submitter.test.ts`.

1. Mở thư mục gốc repo trong VS Code. Mở `services/wallet/src/application/inline-topup-submitter.ts`; đặt breakpoint ở dòng 16 (`await this.deps.submit.executeFor(...)`), dòng 29 (`this.#pending.delete(attempt)`) và dòng 31 (`this.#pending.add(attempt)`).
2. Mở `inline-topup-submitter.test.ts` (file test phải là file đang mở), chọn cấu hình **`Debug current test file (vitest)`** trong `.vscode/launch.json` của dự án, bấm `F5`.
3. Với mỗi lần dừng, ghi lại: dòng nào dừng trước, kích thước của `this.#pending` (thêm vào khung WATCH: `this.#pending.size`).
4. Trả lời: (a) Breakpoint dòng 16 hay dòng 31 dừng **trước**, và vì sao? (b) Khi nào dòng 29 chạy? (c) Test đầu tiên (`starts the submission immediately and does not wait for it`) chứng minh điều gì?

<details><summary>Đáp án</summary>

(a) Dòng 16 dừng trước. Hàm `async` tự gọi ở dòng 15-17 chạy **đồng bộ cho tới `await` đầu tiên** ngay khi biểu thức ở dòng 15-30 được tính, nên thân hàm (dòng 16) chạy xong phần đồng bộ trước; dòng 31 (`#pending.add`) chỉ chạy sau khi cả biểu thức đã tính xong. Test xác nhận: ngay sau `submitSoon(...)` (test dòng 34), `calls` đã chứa lời gọi `executeFor` (test dòng 35). Ở dòng 31, `this.#pending.size` còn bằng 0 trước khi thêm.
(b) Dòng 29 nằm trong `.finally`, chạy sau khi `executeFor` kết thúc (xong hoặc lỗi đã được `.catch`); khi đó `size` còn 1 trước khi xóa.
(c) `submitSoon` trả về `undefined` ngay trong lúc `executeFor` còn "treo" (`gate` chưa được giải phóng): request không bị chậm vì payment, và `drain()` đúng là chờ việc nền xong.

</details>

> Ghi chú của người biên soạn: lệnh chạy test của dự án (khối 1), nội dung bài 5, 6 và thứ tự thực thi trong đáp án (a) (suy ra từ đọc code và từ test dòng 34-35) đã kiểm chứng trên Linux. Thao tác đặt breakpoint trong giao diện VS Code trên Windows **[CHƯA CHẠY]**: hãy ghi lại thứ tự dừng thực tế của bạn.

---

## Khối 4: Viết test cho code thật (55 phút)

Hai bài này bạn viết file test **mới** trong repo, chạy chúng, và kiểm tra test của mình bằng cách **cố tình phá code một chỗ** xem test có đỏ không. Nhớ quy tắc an toàn ở đầu bài.

### Bài 5: Chuỗi backoff mặc định (Trung bình, 25 phút)

Test hiện có của `Topup.recordUnavailable` (`services/wallet/src/domain/topup.test.ts:95-113`) chỉ thử với bậc `[1, 5]`. Bạn kiểm tra chuỗi mặc định đầy đủ `[1, 5, 30, 120, 600]` của `config.ts:41`.

1. Sao chép file mẫu vào repo (PowerShell):

```powershell
Copy-Item node-training\day7\topup-backoff.day7.test.ts.tpl services\wallet\src\domain\topup.day7.test.ts
```

2. Chạy, phải **đỏ** (3 test chưa viết): `corepack pnpm vitest run services/wallet/src/domain/topup.day7.test.ts`
3. Hoàn thành ba test theo các dòng `TODO`.
4. Chạy lại: phải **xanh**.
5. **Kiểm tra test của bạn**: mở `services/wallet/src/domain/topup.ts`, dòng 116, đổi `addSeconds(now, delay)` thành `now` (xóa phần cộng giây), chạy lại test: **ít nhất một test phải đỏ**. Nếu vẫn xanh, test của bạn chưa kiểm tra `nextAttemptAt`: sửa test. Xong **hoàn tác ngay**: `git checkout services/wallet/src/domain/topup.ts`.

### Bài 6: `SubmitTopup` với đối tượng giả (Nâng cao, 30 phút)

Chưa có test đơn vị (chạy không cần database) cho `SubmitTopup`; chỉ có test tích hợp cần Docker. Bạn viết một bộ test bằng **repository giả trong bộ nhớ**, giống cách bạn giả payment ở Ngày 6.

1. Sao chép:

```powershell
Copy-Item node-training\day7\submit-topup.day7.test.ts.tpl services\wallet\src\application\submit-topup.day7.test.ts
```

2. Đọc kỹ hàm `makeWorld` đã viết sẵn: nó dựng `uow` giả (giữ một lệnh trong bộ nhớ), `gateway` giả (trả kết quả bạn chọn), đồng hồ giả, và `logs`. Test mẫu đầu tiên đã có.
3. Viết ba test theo các dòng `TODO 1-3`, xóa test `XÓA SAU KHI XONG`.
4. Chạy: `corepack pnpm vitest run services/wallet/src/application/submit-topup.day7.test.ts` phải **xanh**.
5. **Kiểm tra test của bạn**: mở `services/wallet/src/application/submit-topup.ts`, dòng 86, đổi `current.recordRejected(now)` thành `current.recordUnavailable(now, this.deps.backoffSeconds)`; chạy lại: test "payment từ chối" phải **đỏ**. Hoàn tác: `git checkout services/wallet/src/application/submit-topup.ts`.

Lời giải tham khảo: `node-training/solutions/day7/` (cùng tên file `.tpl`). Chỉ xem sau khi đã thử.

### Dọn dẹp (bắt buộc)

```powershell
Remove-Item services\wallet\src\domain\topup.day7.test.ts, services\wallet\src\application\submit-topup.day7.test.ts
git status
```

`git status` phải báo `nothing to commit, working tree clean`. Nếu còn file khác, kiểm tra từng file; hoàn tác file trong `services/`, `packages/` bằng `git checkout <file>`.

---

## Khối 5: Kể lại luồng, tổng kết tuần (20 phút)

### Bài báo cáo cuối: kể lại luồng (Nâng cao)

Không nhìn tài liệu, viết (hoặc nói) **10-15 dòng** kể lại hành trình của một lần nạp tiền, từ `POST /topups` tới khi số dư tăng, mỗi dòng gồm: **hàm** và **`file:dòng`** (ít nhất 12 chặng). Sau đó đối chiếu với các bảng ở khối 3. Đạt khi:

- Đúng thứ tự các hàm chính: controller → `RequestTopup` → (commit) → `submitSoon` → `executeFor` → `createCharge` → ghi kết quả → (sau đó) webhook → `ApplyPaymentResult` → ghi sổ cái.
- Chỉ ra được **hai chỗ chạy bất đồng bộ nền** và **hai nơi giao dịch SQL bắt đầu / kết thúc**.
- Nói được điều gì xảy ra khi payment chậm, và khi webhook gửi trùng.

### Kiểm tra cuối tuần (10 câu)

1. Nêu bốn lớp trong `services/wallet/src` và vai trò từng lớp.
2. `async/await` giúp wallet phục vụ nhiều request đồng thời như thế nào dù chỉ có một luồng?
3. Vì sao tiền lưu bằng số nguyên?
4. `Idempotency-Key` chống được lỗi gì? Hai request cùng khóa đồng thời được xử lý thế nào trong code thật?
5. Vì sao `POST /topups` trả `202` thay vì `201` hay `200`?
6. Vì sao gọi payment phải nằm **ngoài** giao dịch SQL?
7. `claim` với lease để làm gì?
8. `rejected` và `unavailable` khác nhau ra sao, và chúng dẫn tới trạng thái nào của lệnh nạp?
9. Webhook đến trùng, và webhook "thành công" đến sau khi lệnh đã `FAILED`: mỗi trường hợp code xử lý ra sao?
10. Repo có circuit breaker không? Có gì thay thế?

<details><summary>Đáp án</summary>

1. `interface` (HTTP), `application` (use case), `domain` (quy tắc), `infrastructure` (database, gọi payment).
2. Khi `await`, hàm nhường luồng; Node phục vụ việc khác và quay lại khi Promise xong. Không chờ tức là không chặn.
3. Số thập phân nhị phân có sai số; số nguyên đơn vị nhỏ nhất thì chính xác.
4. Chống xử lý trùng khi client gửi lại. Đồng thời: cùng khóa chính trong bảng, request thua vấp `DuplicateKeyError`, chạy lại một lần và thấy bản ghi của request thắng (`request-topup.ts:78-86`).
5. `202 Accepted` = đã nhận, chưa xử lý xong; kết quả cuối đến sau qua webhook.
6. Để không giữ giao dịch / khóa dòng trong lúc chờ mạng, tránh chặn các request khác.
7. Để lệnh được "giữ chỗ" 60 giây khi đang gửi; nếu process chết giữa chừng thì lệnh tự đến hạn lại để thử lại, không bị kẹt, không bị gửi đồng thời hai nơi.
8. `rejected` → `FAILED (PAYMENT_REJECTED)` ngay; `unavailable` → hẹn thử lại, hết bậc thì `FAILED (PAYMENT_UNAVAILABLE)`.
9. Trùng: `inbox` vấp khóa chính → `DUPLICATE`, không ghi gì thêm. Thành công đến muộn: `applySucceeded` cho phép khi lệnh `FAILED` vì `PAYMENT_UNAVAILABLE` (`topup.ts:122`).
10. Không; chỉ có timeout và thử lại theo bậc.

</details>

### Checklist: tôi đã làm được

- [ ] Chạy được test đơn vị của dự án và nói được test nào cần Docker.
- [ ] Lần theo `GET /wallet` đúng thứ tự, trả lời được các mã lỗi.
- [ ] Lần theo `POST /topups` qua ba chặng, chỉ ra được chỗ bất đồng bộ nền và giao dịch SQL.
- [ ] Đặt breakpoint trong code thật và quan sát được `#pending`.
- [ ] Viết xong Bài 5 và Bài 6, test của mình đỏ khi code bị phá, và đã dọn sạch (`git status` sạch).
- [ ] Viết xong bài báo cáo cuối.

---

## (6) Tùy chọn: chạy cả hệ thống bằng Docker  **[CHƯA CHẠY]**

Phần này **chưa được chạy** trong môi trường biên soạn (không có Docker). Các lệnh bên dưới trích từ tài liệu có sẵn của repo (`docs/ops/local-stack.vi.md`, `README.md:165-170`, `deploy/compose.debug.yml`, `.vscode/launch.json`). Hãy làm theo từng bước và ghi lại chỗ nào khác.

1. Chuẩn bị tệp môi trường: `cp deploy/.env.example deploy/.env`, rồi điền các giá trị mẫu theo bảng trong `docs/ops/local-stack.vi.md` (mật khẩu SQL Server phải đủ mạnh).
2. Chạy stack: `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build`. Lần đầu có thể mất vài phút.
3. Kiểm tra: `curl.exe -s http://localhost:3001/health` (wallet) và `curl.exe -s http://localhost:3002/health` (payment).
4. Gọi luồng thật (tenant mặc định `acme`; xem `README.md:165-170`):

```powershell
curl.exe -s -X POST http://localhost:3001/wallets -H "x-tenant-id: acme" -H "x-customer-id: c1" -H "content-type: application/json" -d "@hoc/day7/wallet.json"
curl.exe -s -X POST http://localhost:3001/topups -H "x-tenant-id: acme" -H "x-customer-id: c1" -H "content-type: application/json" -H "idempotency-key: demo-1" -d "@hoc/day7/topup.json"
curl.exe -s http://localhost:3001/wallet -H "x-tenant-id: acme" -H "x-customer-id: c1"
```

với `wallet.json` chứa `{"currency":"VND"}` và `topup.json` chứa `{"amount":150000}`. Tạo hai file này trong `node-training\hoc\day7` (thư mục `hoc` do Git bỏ qua) và đổi đường dẫn `@hoc/day7/...` cho khớp thư mục bạn đang đứng.
5. Lặp lại lệnh `POST /topups` với cùng `idempotency-key: demo-1` và quan sát phản hồi (bản phát lại). Sau vài giây, `GET /wallet` cho thấy số dư thay đổi khi payment gửi webhook.
6. Debug cả hai service trong Docker: dùng compose debug (`deploy/compose.debug.yml` mở cổng debug `9229` cho wallet và `9230` cho payment) rồi chạy cấu hình **`Attach wallet + payment (Docker)`** trong `.vscode/launch.json`. Đặt breakpoint ở `inline-topup-submitter.ts:16` và `submit-topup.ts:68`, gửi `POST /topups`, và quan sát.
7. Dọn: `docker compose -f deploy/compose.local.yml --env-file deploy/.env down`.

Lưu ý quan sát: wallet **chưa** truyền `x-correlation-id` sang payment trong luồng này; muốn lần theo một request xuyên hai service phải dựa vào `topupId` / `reference` trong log, không dựa vào correlation id.

---

## Tổng kết tuần

| Ngày | Bạn học được | Gặp lại trong code thật |
| ---- | ------------ | ------------------------ |
| 1-2 | JavaScript, `map` / `filter` / `reduce`, module, TypeScript, class, vitest | Mọi file trong `services/` và `packages/` |
| 3 | Bất đồng bộ, `Promise`, `async/await`, chạy nền có `.catch` | `inline-topup-submitter.ts` |
| 4 | Fastify, route, mã trạng thái, `inject` | `interface/http/*.controller.ts` (qua NestJS) |
| 5 | Tiền số nguyên, repository, service, idempotency | `request-topup.ts`, `account.repository.ts` |
| 6 | Timeout, thử lại, máy trạng thái, webhook, debugger | `http-payment-gateway.ts`, `submit-topup.ts`, `topup.ts` |
| 7 | Đọc, chạy, debug, viết test cho luồng thật | Hôm nay |

## Câu hỏi còn mở

- Phần Docker (khối 6) và thao tác debugger trong giao diện VS Code **[CHƯA CHẠY]**.
- Các luồng chưa học: đối soát (`reconciliation`), thanh toán đơn hàng qua RabbitMQ (`pay-order.ts`, `interface/messaging/`), outbox (`relay-outbox.ts`), công cụ vận hành (`ops`). Chọn luồng nào để học tiếp là quyết định của bạn.
- Ghi những chỗ chưa hiểu của cả tuần ở đây.
