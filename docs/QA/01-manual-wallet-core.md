# Manual test plan: Wallet core (ví, nạp tiền, sổ cái)

> **Giai đoạn 2, nhóm A.** Ưu tiên cao nhất theo thứ tự bạn xác nhận: **tiền**, rồi idempotency/đồng thời, rồi tenant. Tài liệu này phủ phần tiền (ví, nạp tiền, sổ cái), idempotency của `POST /topups` và cô lập tenant ở mức API ví. Các nhóm sau (order bất đồng bộ, đối soát, retention, ops) làm ở tài liệu riêng.
> Môi trường: **local stack** (`deploy/compose.local.yml`). Người test **tự đặt header** `x-tenant-id`/`x-customer-id` (đã được xác nhận).
> Không có lệnh nào được chạy khi viết tài liệu này. **Mọi "kết quả mong đợi" đọc từ code, chưa được chạy thật**; cột "Cơ sở" cho biết đọc ở đâu. Chỗ nào chưa chắc ghi **[Chưa xác minh]**: người test ghi lại giá trị thực tế khi chạy lần đầu.

## 1. Chuẩn bị

| Hạng mục | Giá trị | Nguồn |
| --- | --- | --- |
| Dựng stack | `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build` (điền `deploy/.env` từ `deploy/.env.example`) | `docs/ops/local-stack.vi.md` |
| Wallet | `http://localhost:3001` (đổi bằng `LOCAL_WALLET_PORT`) | `docs/ops/local-stack.vi.md` (bảng cổng) |
| Payment | `http://localhost:3002` (đổi bằng `LOCAL_PAYMENT_PORT`) | như trên |
| Tenant hợp lệ | `acme`, `beta` (mặc định `LOCAL_TENANTS`) | `deploy/compose.services.yml:44,86` |
| Đồng tiền hỗ trợ | `VND`, `USD`; số tiền là **số nguyên đơn vị nhỏ nhất** | `packages/money/src/money.ts:3-4,13-18` |
| Webhook payment sang wallet | Đã nối sẵn: `WEBHOOK_URL=http://wallet:3001/webhooks/payment`, chung secret | `deploy/compose.services.yml:65-66,87-88` |
| Điều kiện sẵn sàng | `GET /health` của cả hai service trả `{"status":"ok","service":"wallet"}` / `"payment"`; các job `migrate`, `*-init` thoát mã 0 | `docs/ops/local-stack.vi.md`; `wallet`: `health.controller.ts:3-5`; `payment`: `health.route.ts:4` |

**Quy ước trong các bước:**

```bash
W=http://localhost:3001
# Mỗi test dùng customer id MỚI (chữ, số, _ hoặc -, 1..64 ký tự) để dữ liệu không dính nhau.
H='-H x-tenant-id:acme -H x-customer-id:qa-c001 -H content-type:application/json'
```

- Không có token/Authorization trong code: danh tính **chỉ** từ header (`caller.guard.ts:25-34`; grep không thấy `authorization`/`x-api-key`).
- Lỗi trả dạng `{"error":{"code":"...","message":"..."}}` (`errors.ts`, `AllExceptionsFilter.catch`).
- Nạp tiền là **bất đồng bộ**: `POST /topups` luôn trả `202` rồi mới cộng tiền khi webhook về. Sau khi gọi, **chờ vài giây** và `GET /topups/{id}` đến khi `status` là `SUCCEEDED` hoặc `FAILED`. Giá trị mặc định của vòng worker payment là 500 ms (`services/payment/.env.example`, `WORKER_INTERVAL_MS=500`); thời gian thực tế trên local **[Chưa xác minh]**.
- Wallet chỉ gọi payment **không kèm `X-Simulate`** (`http-payment-gateway.ts:28-38`), nên các kịch bản lỗi của payment (`fail=`, `delay=`, `webhook=drop`...) kiểm bằng nhóm B (payment simulator), không qua `POST /topups` của wallet.

## 2. Luồng nghiệp vụ và trạng thái (để bạn đọc nhanh)

1. `POST /wallets` tạo ví theo (tenant, customer, currency): lần đầu `201`, gọi lại cùng đồng tiền `200`, khác đồng tiền `409 WALLET_CURRENCY_CONFLICT` (`wallets.controller.ts:20-39`, `create-wallet.ts:32-44`, `errors.ts` RULES).
2. `POST /topups` (header `Idempotency-Key` bắt buộc) tạo topup `REQUESTED` và trả `202` (`topups.controller.ts:41-62`, `request-topup.ts`).
3. Wallet gửi charge sang payment; topup chuyển `PENDING` rồi payment gửi webhook về wallet; thành công thì `SUCCEEDED` và ghi sổ cái (cộng ví, trừ tài khoản hệ thống GATEWAY), thất bại thì `FAILED` (`topup.ts`, `apply-payment-result.ts:100-138`, `webhooks.controller.ts:32-80`).
4. Topup `REQUESTED`/`PENDING` có thể `SUCCEEDED` hoặc `FAILED`; topup `FAILED` do `PAYMENT_UNAVAILABLE` vẫn có thể thành `SUCCEEDED` nếu webhook thành công đến muộn (`topup.ts`, `applySucceeded`).
5. Giới hạn: số tiền một lần nạp `1..1_000_000_000_000` đơn vị nhỏ nhất (`topup.ts`, `MAX_TOPUP_AMOUNT`).

## 3. Phân loại: manual hay tự động hóa

| Phần | Manual (nên) | Tự động hóa sau | Lý do |
| --- | --- | --- | --- |
| Hành trình nạp tiền từ đầu đến cuối trên stack thật | **Có** | Postman Smoke (nhóm G) | Test E2E hiện có chạy in-process, không phải stack đã deploy (`tests/e2e/billing.integration.test.ts:12-23`) |
| Validation đầu vào (header/body thiếu, sai kiểu) | Một lượt đầu | Postman Regression (nhóm H) | Rẻ, lặp lại nhiều, ít cần mắt người |
| Idempotency tuần tự (gửi lại cùng key) | Một lượt đầu | Postman Regression | Xác định được, dễ assert |
| Idempotency đồng thời (nhiều request cùng lúc) | Làm tay bằng vòng lặp shell | Đã có test integration (`tests/e2e/billing.integration.test.ts:195`) | Cần công cụ tạo song song, ít phù hợp Postman tay |
| Cô lập tenant | **Có** | Postman Regression | Rủi ro tiền bạc cao, nên có mắt người xác nhận số dư từng tenant |
| Quan sát sổ cái/số dư sau nhiều bước | **Có** | Một phần qua Postman | Đối chiếu số dư với tổng entries cần phán đoán |

## 4. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất (tiền/đúng-sai), **P2** quan trọng, **P3** phụ. "Truy vết" trỏ về luồng ở mục 2 hoặc file code.

### 4.1 Tạo ví

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WLT-001 | Tạo ví mới thành công | Stack lên; customer `qa-c001` chưa có ví ở tenant `acme` | `curl -s -i -X POST $W/wallets $H -d '{"currency":"VND"}'` | `201`; body có `customerId:"qa-c001"`, `currency:"VND"`, `balance:0`, `createdAt` (ISO) | P1 | S | Luồng 1; `wallets.controller.ts:20-39`, `views.ts` `toWalletView` |
| WLT-002 | Tạo ví lặp lại cùng đồng tiền là idempotent | Sau WLT-001 | Gọi lại đúng lệnh WLT-001 | `200` (không phải `201`); cùng `createdAt`, `balance` không đổi | P1 | R | `create-wallet.ts:36`; `wallets.controller.ts:36-37` |
| WLT-003 | Tạo ví khác đồng tiền bị từ chối | Sau WLT-001 | `POST /wallets` cùng customer, `{"currency":"USD"}` | `409`, `error.code = WALLET_CURRENCY_CONFLICT`; ví cũ vẫn `VND` | P1 | R | `create-wallet.ts:32`; `errors.ts` RULES |
| WLT-004 | Đồng tiền không hỗ trợ | Customer mới | `POST /wallets` với `{"currency":"EUR"}` | `400`, `INVALID_REQUEST` **[Chưa xác minh]**: suy ra từ `Money.of` ném `InvalidMoneyError` (`money.ts:16-18`) và RULES ánh xạ sang `400 INVALID_REQUEST`; chưa đọc `create-wallet.ts` đủ để chắc ví không bị tạo | P2 | R | `money.ts`; `errors.ts` RULES |
| WLT-005 | Body không phải JSON object | — | `POST /wallets` với body `[]` và body `"abc"` | `400`, `INVALID_REQUEST` | P2 | R | `wallets.controller.ts:25-27` |
| WLT-006 | `currency` sai kiểu | — | `POST /wallets` với `{"currency":123}` và `{}` | `400`, `INVALID_REQUEST` ("currency must be a string") | P2 | R | `wallets.controller.ts:29-31` |
| WLT-007 | Thiếu tenant | — | Bỏ header `x-tenant-id` | `400`, `MISSING_TENANT` | P1 | R | `errors.ts` RULES; `caller.guard.ts:29` (`registry.resolve`) |
| WLT-008 | Tenant lạ | — | `x-tenant-id: zzz` (hợp lệ về định dạng, không có trong `LOCAL_TENANTS`) | `403`, `UNKNOWN_TENANT` | P1 | R | `errors.ts` RULES |
| WLT-009 | Thiếu customer | — | Bỏ `x-customer-id` (hoặc để rỗng/khoảng trắng) | `400`, `MISSING_CUSTOMER` | P2 | R | `caller.guard.ts:30-33` |
| WLT-010 | Customer id sai định dạng | — | `x-customer-id: "bad id!"`; `x-customer-id` dài 65 ký tự | `400`, `INVALID_REQUEST` | P2 | R | `customer-id.ts` (`^[A-Za-z0-9_-]{1,64}$`); `errors.ts` RULES |
| WLT-011 | Tenant sai định dạng | — | `x-tenant-id: ACME` (chữ hoa) | Bị từ chối, mã cụ thể **[Chưa xác minh]**: `TenantId` yêu cầu `^[a-z][a-z0-9-]{0,39}$` (`tenant-id.ts`), nhưng chưa đọc `tenant-registry.ts` để biết `400` hay `403` | P3 | R | `tenant-id.ts` |
| WLT-012 | Đọc ví | Sau WLT-001 | `curl -s $W/wallet $H` | `200`; cùng nội dung WLT-001; `balance:0` | P1 | S | `wallets.controller.ts:41-44` |
| WLT-013 | Đọc ví chưa tạo | Customer chưa có ví | `GET /wallet` | `404`, `WALLET_NOT_FOUND` | P2 | R | `get-wallet.ts:15`; `errors.ts` RULES |

### 4.2 Nạp tiền (happy path và trạng thái)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TOP-001 | **Hành trình nạp tiền thành công end-to-end** | Ví `VND` `qa-c001` có `balance:0`; payment và wallet khỏe | (1) `curl -s -i -X POST $W/topups $H -H 'idempotency-key: qa-top-001' -d '{"amount":150000}'`; (2) ghi `topupId`; (3) lặp `GET /topups/{topupId}` mỗi 1-2 s đến khi `status` là `SUCCEEDED`; (4) `GET /wallet`; (5) `GET /wallet/entries` | (1) `202`, body `status:"REQUESTED"`, `amount:150000`, `currency:"VND"`; (3) `status` chuyển `SUCCEEDED`, có `completedAt`; (4) `balance:150000`; (5) có **đúng 1** entry mới có `amount` **dương 150000** (`businessKey` là `topup:<topupId>`, `ledger-transaction.ts:87`; dấu của số tiền: ghi lại **[Chưa xác minh]**) | P1 | S | Luồng 2-3; `request-topup.ts`; `apply-payment-result.ts:100-138`; `views.ts` `EntryView` |
| TOP-002 | Không cộng tiền khi chưa có webhook | Ví số dư 0 | Gọi `POST /topups` rồi **ngay lập tức** `GET /wallet` (trước khi topup xong) | Có thể thấy `balance:0` khi topup còn `REQUESTED`/`PENDING`; chỉ tăng sau `SUCCEEDED` | P2 | R | Luồng 3; phụ thuộc thời gian chạy nên có thể khó bắt, ghi nhận nếu thấy |
| TOP-003 | Tra cứu topup | Sau TOP-001 | `GET /topups/{topupId}` | `200`; `topupId`, `status`, `amount`, `currency`, `createdAt`; `failureCode` chỉ có khi thất bại | P1 | S | `topups.controller.ts:65-72`; `views.ts` `TopupView` |
| TOP-004 | Topup không tồn tại | — | `GET /topups/does-not-exist` | `404`, `TOPUP_NOT_FOUND` | P2 | R | `errors.ts` RULES |
| TOP-005 | Topup của khách khác không tra cứu được | Topup của `qa-c001` | `GET /topups/{id}` với `x-customer-id: qa-c999` (cùng tenant) | `404` `TOPUP_NOT_FOUND` **[Chưa xác minh]**: controller truyền `customerId` vào use case, chưa đọc `get-topup.ts` để chắc là lọc theo customer | P1 | R | `topups.controller.ts:66-72` |
| TOP-006 | Số tiền tối thiểu | Ví `VND` | `POST /topups` với `{"amount":1}` | `202` và nạp thành công như TOP-001, số dư +1 | P2 | R | `topup.ts` (`isPositive`) |
| TOP-007 | Số tiền bằng 0 | Ví `VND` | `POST /topups` với `{"amount":0}` | `400`, `INVALID_REQUEST` ("amount must be at least 1 minor unit") | P1 | R | `topup.ts` (`request` kiểm `isPositive`); `errors.ts` RULES (`InvalidTopupError` sang 400) |
| TOP-008 | Số tiền âm | Ví `VND` | `{"amount":-1000}` | `400`, `INVALID_REQUEST` | P1 | R | như TOP-007 |
| TOP-009 | Số tiền vượt trần | Ví `VND` | `{"amount":1000000000001}` | `400`, `INVALID_REQUEST` ("must not exceed 1000000000000") | P1 | R | `topup.ts` `MAX_TOPUP_AMOUNT` |
| TOP-010 | Số tiền đúng trần | Ví `VND` (customer mới) | `{"amount":1000000000000}` | `202` (chấp nhận); **cẩn thận số dư hiển thị**; số này nằm trong phạm vi số nguyên an toàn của JS | P3 | R | `topup.ts`; `money.ts:13` |
| TOP-011 | Số tiền thập phân | Ví `VND` | `{"amount":100.5}` | `400`, `INVALID_REQUEST` (không phải số nguyên an toàn) | P1 | R | `money.ts:13-15` |
| TOP-012 | `amount` sai kiểu | Ví `VND` | `{"amount":"1000"}`; `{}`; `{"amount":null}` | `400`, `INVALID_REQUEST` ("amount must be a number") | P2 | R | `topups.controller.ts:52-54` |
| TOP-013 | Body không phải object | Ví `VND` | body `[]` | `400`, `INVALID_REQUEST` | P3 | R | `topups.controller.ts:49-51` |
| TOP-014 | Nạp vào ví chưa tồn tại | Customer chưa có ví | `POST /topups` với key mới | `404`, `WALLET_NOT_FOUND` | P1 | R | `request-topup.ts` (`WalletNotFoundError`); `errors.ts` RULES |
| TOP-015 | Tiền nạp theo đồng tiền của ví | Ví `USD` (customer mới) | `POST /topups` `{"amount":5000}` | Topup có `currency:"USD"`, không nhận currency từ body (body chỉ có `amount`) | P2 | R | `request-topup.ts` (`Money.of(input.amount, wallet currency)`) |

### 4.3 Idempotency của nạp tiền

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IDM-001 | Thiếu `Idempotency-Key` | Ví có sẵn | `POST /topups` không header `idempotency-key` | `400`, `MISSING_IDEMPOTENCY_KEY` | P1 | R | `topups.controller.ts:20-24` |
| IDM-002 | Key sai định dạng | Ví có sẵn | Key có khoảng trắng đầu/cuối (`' k1 '`); key dài 256 ký tự | `400`, `INVALID_IDEMPOTENCY_KEY` | P2 | R | `topups.controller.ts:25-31` (`MAX_KEY_LENGTH=255`) |
| IDM-003 | Gửi lại cùng key và cùng nội dung trả lại đúng kết quả cũ | Ví có sẵn | Gửi `POST /topups` key `qa-idm-003`, `{"amount":1000}` hai lần liên tiếp | Cả hai lần `202`, **cùng `topupId`**; sau khi xong, số dư chỉ tăng **một lần** (1000) | P1 | S | `request-topup.ts` (`replay`); `tests/e2e/billing.integration.test.ts:195` |
| IDM-004 | Cùng key, khác số tiền | Sau IDM-003 | Gửi key `qa-idm-003` với `{"amount":2000}` | `422`, `IDEMPOTENCY_KEY_REUSED`; không tạo topup mới | P1 | R | `request-topup.ts` (`IdempotencyConflictError`); `errors.ts` RULES |
| IDM-005 | Key trùng ở khách khác không va chạm | Hai ví `qa-c001`, `qa-c002` (cùng tenant) | Cùng key `shared-key` cho hai khách | Hai topup độc lập, hai `topupId` khác nhau | P1 | R | `request-topup.ts` (`idempotency.find(customerId, key)`) |
| IDM-006 | Gửi đồng thời cùng key | Ví có sẵn | Bắn 5 request song song cùng key và nội dung (ví dụ `for i in 1 2 3 4 5; do curl ... & done; wait`) | Mọi phản hồi `202` cùng `topupId`; sau khi xong số dư tăng **đúng 1 lần** | P1 | R | `request-topup.ts` (xử lý `DuplicateKeyError`); `tests/e2e/billing.integration.test.ts:195` |

### 4.4 Sổ cái và danh sách entries

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LED-001 | Liệt kê entries mặc định | Ví đã có ≥ 1 topup thành công | `GET /wallet/entries` | `200`; `{items:[...], nextCursor:...}`; mỗi item có `entryId`, `transactionId`, `businessKey`, `amount`, `createdAt` | P1 | S | `list-entries.ts`; `views.ts` `EntryView` |
| LED-002 | Số dư khớp tổng entries | Ví có ≥ 2 topup thành công | Cộng `amount` của mọi entry (phân trang đến hết) so với `GET /wallet` `balance` | Hai số bằng nhau | P1 | S | `apply-payment-result.ts:117-135` (ví +amount, ghi sổ cùng giao dịch) |
| LED-003 | Phân trang | Ví có ≥ 3 entries | `GET /wallet/entries?limit=1`, rồi dùng `nextCursor` cho trang sau | Mỗi trang 1 item; `nextCursor` là `null` ở trang cuối; không trùng/khuyết entry | P2 | R | `list-entries.ts:28-49` |
| LED-004 | `limit` không hợp lệ | Ví có sẵn | `limit=0`, `limit=1001`, `limit=abc`, `limit=1.5` | `400`, `INVALID_QUERY` | P2 | R | `list-entries.ts:29-31` (`MAX_ENTRIES_LIMIT=1000`); `wallets.controller.ts` (`Number(limit)`) |
| LED-005 | `cursor` không hợp lệ | Ví có sẵn | `cursor=abc` | `400`, `INVALID_QUERY` ("cursor is invalid"); định dạng hợp lệ của cursor **[Chưa xác minh]** (regex `CURSOR` chưa đọc) | P3 | R | `list-entries.ts` |
| LED-006 | `limit`/`cursor` lặp tham số | Ví có sẵn | `?limit=1&limit=2` | `400`, `INVALID_QUERY` | P3 | R | `wallets.controller.ts:49-51` |
| LED-007 | Entries của ví chưa tạo | Customer chưa có ví | `GET /wallet/entries` | `404`, `WALLET_NOT_FOUND` | P2 | R | `list-entries.ts` |
| LED-008 | Topup thất bại do payment không khả dụng không để lại entry | Được phép tạm dừng `payment` (đã xác nhận); ví `VND` số dư biết trước | (1) `docker compose -f deploy/compose.local.yml --env-file deploy/.env stop payment`; (2) `POST /topups` key mới; (3) theo dõi `GET /topups/{id}` ≈ 13 phút; (4) `start payment` | Topup ở `REQUESTED` và được thử lại theo backoff `1,5,30,120,600` s; sau lần thất bại thứ 6 chuyển `FAILED`, `failureCode:"PAYMENT_UNAVAILABLE"`, `completedAt` có giá trị (tổng ≈ 756 s); số dư không đổi; không có entry mới. Nếu dừng ngắn rồi `start payment` sớm: topup tự `PENDING`→`SUCCEEDED` | P2 | R | `topup.ts` (`recordUnavailable`); `services/wallet/.env.example:29` (`TOPUP_SUBMIT_BACKOFF`) |

### 4.5 Cô lập tenant

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TEN-001 | Cùng customer id ở hai tenant là hai ví độc lập | Tenant `acme` và `beta` | Tạo ví `qa-ten1` ở cả hai; nạp 1000 ở `acme`, 2000 ở `beta` | `GET /wallet` ở `acme` `balance:1000`; ở `beta` `balance:2000` | P1 | S | `tests/e2e/billing.integration.test.ts:228`; `deploy/compose.services.yml:44` |
| TEN-002 | Topup không "rò" sang tenant khác | Sau TEN-001 | `GET /topups/{id của acme}` với header `x-tenant-id: beta` | `404`, `TOPUP_NOT_FOUND` | P1 | R | `topups.controller.ts:66-72`; schema theo tenant (ADR-0006) |
| TEN-003 | Entries không lẫn giữa tenant | Sau TEN-001 | `GET /wallet/entries` ở `beta` | Chỉ thấy entry 2000 của `beta` | P1 | R | như trên |
| TEN-004 | Idempotency key chỉ có nghĩa trong một tenant | Hai tenant | Dùng cùng `Idempotency-Key` và cùng customer id ở `acme` và `beta` | Hai topup độc lập, cùng thành công | P2 | R | `request-topup.ts` (uow theo tenant); ADR-0006 |

### 4.6 Webhook nhận vào (kiểm tra từ chối; không cần tính chữ ký)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WHK-001 | Webhook không chữ ký bị từ chối | Wallet khỏe | `curl -s -i -X POST $W/webhooks/payment -H 'content-type: application/json' -d '{}'` | `401`, `INVALID_SIGNATURE` | P1 | R | `webhooks.controller.ts:42-52` |
| WHK-002 | Chữ ký sai bị từ chối | Wallet khỏe | Thêm `-H 'x-signature: abc'` | `401`, `INVALID_SIGNATURE`; thông điệp không lộ chữ ký/secret | P1 | R | `webhooks.controller.ts:50-52` |
| WHK-003 | Webhook hợp lệ do QA tự ký: tenant lạ/không xác định | Có `LOCAL_WEBHOOK_SECRET` (trong `deploy/.env`) | Tạo body JSON hợp lệ (xem mục 4.7), ký bằng lệnh ở mục 4.7, `POST /webhooks/payment` | Với `metadata.tenantId` thiếu/lạ: `400 INVALID_WEBHOOK` ("does not identify a known tenant"); với tenant `acme` và `reference` không khớp topup: `200 {"outcome":"UNKNOWN_TOPUP"}` | P1 | R | `webhooks.controller.ts:54-80`; `apply-payment-result.ts:103` |

### 4.7 Webhook ký tay (đã xác nhận: kiểm tra bằng tay)

Quy tắc ký: header `x-signature: t=<unix giây>,v1=<hex HMAC-SHA256 của "<t>.<body thô>" bằng secret>`; lệch thời gian quá 300 s bị từ chối (`packages/contracts/src/webhook.ts` `signWebhook`, `verifyWebhook`, `DEFAULT_TOLERANCE_SECONDS`).

```bash
SECRET='<LOCAL_WEBHOOK_SECRET trong deploy/.env>'   # KHÔNG commit, không dán vào tài liệu
BODY='{"eventId":"qa-evt-1","type":"charge.succeeded","createdAt":"2026-10-13T00:00:00Z","data":{"chargeId":"qa-ch-1","reference":"qa-unknown-topup","amount":1000,"currency":"VND","status":"SUCCEEDED","completedAt":"2026-10-13T00:00:00Z","metadata":{"tenantId":"acme"}}}'
T=$(date +%s)
SIG="t=$T,v1=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
curl -s -i -X POST $W/webhooks/payment -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"
```

Lưu ý: thân gửi đi phải **đúng từng byte** với chuỗi đã ký (`-d "$BODY"`, không để curl/shell đổi nội dung).

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WHK-004 | Webhook ký đúng, topup không tồn tại | Lệnh mục 4.7 | Chạy nguyên văn | `200`, `{"outcome":"UNKNOWN_TOPUP"}`; số dư mọi ví không đổi | P1 | R | `webhooks.controller.ts:72-80`; `apply-payment-result.ts:103` |
| WHK-005 | Chữ ký đúng nhưng quá hạn (replay) | Như trên | Dùng `T=$(( $(date +%s) - 600 ))` rồi ký lại | `401`, `INVALID_SIGNATURE` | P1 | R | `webhook.ts` (`EXPIRED`; dung sai 300 s) |
| WHK-006 | Sửa thân sau khi ký | Như trên | Đổi `amount` trong thân gửi đi nhưng giữ `SIG` cũ | `401`, `INVALID_SIGNATURE` | P1 | R | `webhook.ts` (`MISMATCH`) |
| WHK-007 | Chữ ký đúng nhưng thân sai schema | Ký lại cho thân sai | Thân `{"eventId":"x"}` (thiếu trường) hoặc `charge.succeeded` kèm `status:"FAILED"` | `400`, `INVALID_WEBHOOK` kèm danh sách lỗi | P2 | R | `webhook.ts` `validateChargeWebhook`; `webhooks.controller.ts:55-62` |
| WHK-008 | Chữ ký đúng, thân không phải JSON | Ký lại cho thân `not json` | `POST` | `400`, `INVALID_WEBHOOK` ("body is not valid JSON") | P3 | R | `errors.ts` `mapWebhookBodyError` |
| WHK-009 | Tenant không có trong `metadata` | Ký lại thân bỏ `metadata` | `POST` | `400`, `INVALID_WEBHOOK` ("does not identify a known tenant") | P1 | R | `webhooks.controller.ts:64-72` |
| WHK-010 | Gửi lại cùng `eventId` | Sau WHK-004 | Ký lại (timestamp mới) và gửi lại cùng thân | `200`, `{"outcome":"DUPLICATE"}`; không tác dụng phụ | P1 | R | `apply-payment-result.ts:76,100` (`inbox.record`) |
| WHK-011 | Topup khớp nhưng số tiền lệch | Một topup `PENDING` có `reference`=`topupId`, `amount` khác | Gửi webhook với `reference` = `topupId` nhưng `amount` khác | `200`, `{"outcome":"MISMATCH"}`; số dư và topup không đổi | P1 | R | `apply-payment-result.ts:106-110` |

## 5. Bộ Smoke đề xuất (chạy mỗi lần deploy)

`WLT-001`, `WLT-012`, `TOP-001`, `TOP-003`, `IDM-003`, `LED-001`, `LED-002`, `TEN-001`. Tám case này phủ: tạo ví, nạp tiền end-to-end, idempotency cơ bản, sổ cái khớp số dư, hai tenant.

## 6. Kết quả thực thi (điền khi chạy)

| ID | Ngày | Người test | Kết quả (Pass/Fail/Blocked) | Giá trị thực tế khi khác mong đợi | Defect |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 7. Câu hỏi còn mở (riêng nhóm này)

Đã xác nhận: được tạm dừng `payment` (LED-008); kiểm tra webhook bằng tay (mục 4.7).

1. **Dấu và `businessKey` của entry** (TOP-001): có cần tôi đọc `LedgerTransaction.topup` và điền giá trị cụ thể trước khi chạy không?
2. **WHK-011**: cần một topup `PENDING` có `chargeId`; cách tạo ổn định ở local (payment hoàn tất rất nhanh, 500 ms) **[Chưa xác minh]**: có thể phải dừng `payment` hoặc dùng topup `REQUESTED` (webhook vẫn được áp dụng cho `REQUESTED`, `topup.ts` `applySucceeded`).
